/**
 * codex-backup.mjs — 按类采集 Codex 客户端（~/.codex）的配置与自定义资产（APDEVIMP-83）。
 *
 * 每类单独产出「可单独上传的载荷」，服务端逐类存为独立 blob（避免 memories/** 增长
 * 带来的写放大；每类独立 checksum，未变则短路 unchanged）。仅 Codex 类型客户端使用。
 *
 * 类别：
 *   单文件类  config(config.toml, TOML 脱敏) / guidance(AGENTS.md) / hooks(hooks.json, JSON 键级脱敏)
 *   多文件类  agents(agents/*.toml) / skills(排除 .system) / rules / local-memory(memories/**)
 *
 * 脱敏在客户端完成：config/agents 走 TOML 脱敏（redactTomlSecrets），hooks/JSON 走键级
 * 脱敏（redactSecrets），其余走值级脱敏（scanTextSecrets）。checksum 只对内容计算、不含
 * collectedAt，内容未变时稳定 → 服务端可短路 unchanged。
 *
 * 设计原则：纯函数 + 可注入（codexHome / now），零外部依赖，易于测试。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { redactSecrets, checksumOf } from './settings-backup.mjs';
import { redactTomlSecrets } from './codex-config-backup.mjs';
import { scanTextSecrets } from './resource-backup.mjs';

/** Bundle schema version. */
export const SCHEMA_VERSION = '1';

/** Per-file byte ceiling — larger files are skipped (recorded in `skipped`). */
const PER_FILE_MAX = 256 * 1024;
/** Total per-category byte budget — files beyond it are skipped (recorded). */
const TOTAL_MAX = 5 * 1024 * 1024;

/** Directory names never backed up (machine-local / VCS noise). */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 默认 Codex home：$CODEX_HOME（缺省 ~/.codex）。 */
function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** 读取文件文本；不存在返回 null。 */
function readTextIfExists(abs) {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** 缺失单文件类的统一载荷。 */
function absentSingle(category) {
  return { category, kind: 'single', present: false };
}

/** 由脱敏后的内容组装单文件类载荷。 */
function makeSingle(category, relPath, content, redactedCount) {
  return {
    category,
    kind: 'single',
    present: true,
    relPath,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    checksum: checksumOf(content),
    redactedCount,
    content,
  };
}

/** 采集 config.toml（TOML 脱敏）。 */
function collectConfig(codexHome) {
  const raw = readTextIfExists(join(codexHome, 'config.toml'));
  if (raw === null) return absentSingle('config');
  const { sanitized, redactedKeys } = redactTomlSecrets(raw);
  return makeSingle('config', 'config.toml', sanitized, redactedKeys.length);
}

/** 采集 AGENTS.md（值级文本脱敏）。 */
function collectGuidance(codexHome) {
  const raw = readTextIfExists(join(codexHome, 'AGENTS.md'));
  if (raw === null) return absentSingle('guidance');
  const scan = scanTextSecrets(raw);
  return makeSingle('guidance', 'AGENTS.md', scan.text, scan.count);
}

/** 采集 hooks.json（JSON 键级脱敏 + 内联值级兜底）。 */
function collectHooks(codexHome) {
  const raw = readTextIfExists(join(codexHome, 'hooks.json'));
  if (raw === null) return absentSingle('hooks');
  try {
    const parsed = JSON.parse(raw);
    const { sanitized, redactedKeys } = redactSecrets(parsed);
    const pretty = JSON.stringify(sanitized, null, 2);
    const scan = scanTextSecrets(pretty);
    return makeSingle('hooks', 'hooks.json', scan.text, redactedKeys.length + scan.count);
  } catch {
    const scan = scanTextSecrets(raw);
    return makeSingle('hooks', 'hooks.json', scan.text, scan.count);
  }
}

// ---------------------------------------------------------------------------
// 多文件类：目录递归采集（复用 resource-backup 的 files[]+manifest 形态）
// ---------------------------------------------------------------------------

/** Join path segments with POSIX separators (stable relPath across OSes). */
function posixJoin(...parts) {
  return parts.filter(Boolean).join('/');
}

/** Classify a file by extension (then shebang) into a coarse content type. */
function detectType(relPath, content) {
  const ext = extname(relPath).toLowerCase();
  if (ext === '.toml') return 'toml';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'shell';
  if (content && content.startsWith('#!')) return 'shell';
  return 'text';
}

/**
 * Redact a file's content client-side by type: TOML → key-scan TOML redaction;
 * JSON → key-level redactSecrets (+ inline value scan); everything else → value scan.
 *
 * @returns {{ content: string, redactedCount: number }}
 */
function redactByType(type, raw) {
  if (type === 'toml') {
    const { sanitized, redactedKeys } = redactTomlSecrets(raw);
    return { content: sanitized, redactedCount: redactedKeys.length };
  }
  if (type === 'json') {
    try {
      const parsed = JSON.parse(raw);
      const { sanitized, redactedKeys } = redactSecrets(parsed);
      const pretty = JSON.stringify(sanitized, null, 2);
      const scan = scanTextSecrets(pretty);
      return { content: scan.text, redactedCount: redactedKeys.length + scan.count };
    } catch {
      /* not valid JSON → fall through to text scan */
    }
  }
  const scan = scanTextSecrets(raw);
  return { content: scan.text, redactedCount: scan.count };
}

/** Read one file; skip (recording why) if binary / oversize / over budget, else redact + push. */
function addFile(abs, relPath, category, state) {
  if (state.seen.has(relPath)) return;
  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return;
  }
  if (buf.includes(0)) {
    state.skipped.push({ category, relPath, reason: 'binary' });
    return;
  }
  if (buf.length > PER_FILE_MAX) {
    state.skipped.push({ category, relPath, reason: 'too-large', sizeBytes: buf.length });
    return;
  }
  if (state.totalBytes + buf.length > TOTAL_MAX) {
    state.skipped.push({ category, relPath, reason: 'budget-exceeded', sizeBytes: buf.length });
    return;
  }
  const raw = buf.toString('utf8');
  const type = detectType(relPath, raw);
  const { content, redactedCount } = redactByType(type, raw);
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  state.totalBytes += sizeBytes;
  state.seen.add(relPath);
  state.files.push({ category, relPath, type, sizeBytes, checksum: checksumOf(content), redactedCount, content });
}

/**
 * Recursively walk a category directory, skipping hidden entries (this excludes
 * `skills/.system`), cache / VCS noise, lockfiles, and .sqlite runtime state.
 */
function walkDir(absDir, relPrefix, category, state) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = posixJoin(relPrefix, e.name);
    if (e.name.startsWith('.')) {
      // Hidden entries = machine-local state / builtins (e.g. skills/.system).
      state.skipped.push({ category, relPath: rel, reason: 'excluded' });
      continue;
    }
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || /cache/i.test(e.name)) {
        state.skipped.push({ category, relPath: rel, reason: 'excluded' });
        continue;
      }
      walkDir(abs, rel, category, state);
    } else if (e.isFile()) {
      if (e.name.endsWith('.lock') || e.name.endsWith('.sqlite')) {
        state.skipped.push({ category, relPath: rel, reason: 'excluded' });
        continue;
      }
      addFile(abs, rel, category, state);
    }
  }
}

/** 缺失多文件类的统一载荷。 */
function absentMulti(category) {
  return { category, kind: 'multi', present: false };
}

/**
 * 采集一个目录类别为多文件载荷（bundle + content-free manifest + 稳定 checksum）。
 * 目录不存在 → present:false。
 */
function collectDir(codexHome, dirName, category, now) {
  const absDir = join(codexHome, dirName);
  try {
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return absentMulti(category);
  } catch {
    return absentMulti(category);
  }

  const state = { files: [], skipped: [], totalBytes: 0, seen: new Set() };
  walkDir(absDir, dirName, category, state);

  // Deterministic ordering → stable bundle/manifest/checksum across runs.
  const byRelPath = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  state.files.sort(byRelPath);
  state.skipped.sort(byRelPath);

  if (state.files.length === 0) return absentMulti(category);

  // Checksum over (relPath, per-file checksum) only — excludes collectedAt.
  const checksum = checksumOf(JSON.stringify(state.files.map((f) => [f.relPath, f.checksum])));
  const manifestFiles = state.files.map(({ content, ...rest }) => rest);
  const bundle = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    agent: 'codex',
    category,
    collectedAt: now,
    checksum,
    files: state.files,
    skipped: state.skipped,
  });
  const manifest = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    agent: 'codex',
    category,
    collectedAt: now,
    fileCount: state.files.length,
    checksum,
    files: manifestFiles,
    skipped: state.skipped,
  });
  const redactions = state.files
    .filter((f) => f.redactedCount > 0)
    .map((f) => ({ relPath: f.relPath, count: f.redactedCount }));

  return {
    category,
    kind: 'multi',
    present: true,
    fileCount: state.files.length,
    totalBytes: state.totalBytes,
    checksum,
    files: state.files,
    manifest,
    bundle,
    redactions,
    redactedTotal: redactions.reduce((n, r) => n + r.count, 0),
    skipped: state.skipped,
  };
}

/**
 * 按类采集 Codex 配置与资产。
 *
 * @param {object} [opts]
 * @param {string} [opts.codexHome] - 根目录（默认 $CODEX_HOME || ~/.codex）；测试注入
 * @param {string|function} [opts.now] - collectedAt（ISO 或 () => iso）
 * @returns {{ collectedAt: string, categories: Record<string, object> }}
 */
export function collectCodexBackup(opts = {}) {
  const codexHome = opts.codexHome || defaultCodexHome();
  const now = opts.now
    ? typeof opts.now === 'function'
      ? opts.now()
      : opts.now
    : new Date().toISOString();

  return {
    collectedAt: now,
    categories: {
      config: collectConfig(codexHome),
      guidance: collectGuidance(codexHome),
      hooks: collectHooks(codexHome),
      agents: collectDir(codexHome, 'agents', 'agents', now),
      skills: collectDir(codexHome, 'skills', 'skills', now),
      rules: collectDir(codexHome, 'rules', 'rules', now),
      'local-memory': collectDir(codexHome, 'memories', 'local-memory', now),
    },
  };
}
