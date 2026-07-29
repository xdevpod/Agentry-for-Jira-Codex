/**
 * resource-backup.mjs — 采集 ~/.claude 下的自定义资产，打包成一个 bundle。
 *
 * 专为 jira_backup_resources MCP 工具服务（APDEVIMP-16）。资产分 6 类：
 *   rules/、agents/、commands/、skills/（含 SKILL.md + 脚本）、output-styles/、
 *   keybindings.json，外加 settings.json 引用的脚本（statusline / hooks，**仅当
 *   解析路径位于 ~/.claude 内**）。
 *
 * 记忆文件（CLAUDE.md / memdir / agent-memory）已拆到 memory-backup.mjs（APDEVIMP-23），
 * 不在本模块范围。
 *
 * 与 settings/claude-config 备份的差异：资产是一棵「多类型文件树」（markdown /
 * json / shell），skills 是目录。因此本模块产出两样东西：
 *   - bundle   —— 每个文件含内容（上传的完整内容 blob）
 *   - manifest —— 同样的文件清单但不含内容（供查看页廉价列出/预览）
 *
 * 安全：脱敏在客户端完成。JSON 复用 settings-backup 的 redactSecrets（键级），
 * 自由文本/脚本用 scanTextSecrets（值级正则）。凭据类文件不在范围；二进制 /
 * 超限 / 机器本地状态（隐藏文件、node_modules、cache、lock）跳过并记入 skipped。
 * 去重 checksum 只对「文件 relPath + 各文件 checksum」计算，不含 collectedAt，
 * 因此内容未变时 checksum 稳定 → 服务端可短路 unchanged。
 *
 * 设计原则：纯函数 + 可注入（home / claudeDir / now），零外部依赖，易于测试。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { redactSecrets, checksumOf } from './settings-backup.mjs';

/** Bundle schema version. */
export const SCHEMA_VERSION = '1';

/** Per-file byte ceiling — larger files are skipped (recorded in `skipped`). */
const PER_FILE_MAX = 256 * 1024;
/** Total bundle byte budget — files beyond it are skipped (recorded). */
const TOTAL_MAX = 5 * 1024 * 1024;

/** Directory-rooted categories: [category, dirName] (walked recursively). */
const DIR_CATEGORIES = [
  ['rules', 'rules'],
  ['agents', 'agents'],
  ['commands', 'commands'],
  ['skills', 'skills'],
  ['output-styles', 'output-styles'],
];
/** Single-file categories: [category, fileName] (at the ~/.claude root). */
const FILE_CATEGORIES = [
  ['keybindings', 'keybindings.json'],
];

/** Directory names never backed up (machine-local / VCS noise). */
const SKIP_DIRS = new Set(['node_modules', '.git']);

// ---------------------------------------------------------------------------
// scanTextSecrets — value-level secret scrubbing for free text / scripts
// ---------------------------------------------------------------------------

/** Inline secret-value patterns (provider token shapes). */
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,          // OpenAI / Anthropic style
  /\bgh[posru]_[A-Za-z0-9]{20,}/g,     // GitHub PAT / OAuth tokens
  /\bAKIA[0-9A-Z]{16}\b/g,             // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,   // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}/g,          // Google API key
];

/**
 * Replace inline secret-looking values in free text with ***REDACTED***.
 * Returns the scrubbed text and the number of redactions applied.
 *
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function scanTextSecrets(text) {
  let count = 0;
  let out = String(text);
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return '***REDACTED***';
    });
  }
  // Bearer header values
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/g, () => {
    count++;
    return 'Bearer ***REDACTED***';
  });
  // PEM private-key blocks
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => {
      count++;
      return '-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----';
    }
  );
  return { text: out, count };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** Join path segments with POSIX separators (stable relPath across OSes). */
function posixJoin(...parts) {
  return parts.filter(Boolean).join('/');
}

/** Convert an OS-specific path to POSIX separators. */
function toPosix(p) {
  return String(p).split(sep).join('/');
}

/** Classify a file by extension (then shebang) into a coarse content type. */
function detectType(relPath, content) {
  const ext = extname(relPath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  if (ext === '.sh' || ext === '.bash' || ext === '.zsh') return 'shell';
  if (content && content.startsWith('#!')) return 'shell';
  return 'text';
}

/**
 * Redact a file's content client-side. JSON → key-level redactSecrets (then a
 * value-level pass for inline secrets); everything else → value-level scan.
 *
 * @returns {{ content: string, redactedCount: number }}
 */
function redactContent(type, raw) {
  if (type === 'json') {
    try {
      const parsed = JSON.parse(raw);
      const { sanitized, redactedKeys } = redactSecrets(parsed);
      const pretty = JSON.stringify(sanitized, null, 2);
      const scan = scanTextSecrets(pretty);
      return { content: scan.text, redactedCount: redactedKeys.length + scan.count };
    } catch {
      // not valid JSON → fall through to text scan
    }
  }
  const scan = scanTextSecrets(raw);
  return { content: scan.text, redactedCount: scan.count };
}

/**
 * Read one file, skip it (recording why) if binary / oversize / over budget,
 * otherwise redact + push it to `state.files`.
 */
function addFile(abs, relPath, category, state) {
  if (state.seen.has(relPath)) return;

  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return; // unreadable → silently ignore
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
  const { content, redactedCount } = redactContent(type, raw);

  let mode = '';
  try {
    mode = (statSync(abs).mode & 0o777).toString(8);
  } catch {
    /* mode is informational (future restore exec bit); ok to omit */
  }

  const sizeBytes = Buffer.byteLength(content, 'utf8');
  state.totalBytes += sizeBytes;
  state.seen.add(relPath);
  state.files.push({
    category,
    relPath,
    type,
    sizeBytes,
    checksum: checksumOf(content),
    mode,
    redactedCount,
    content,
  });
}

/** Recursively walk a category directory, skipping hidden / state / VCS noise. */
function walkDir(absDir, relPrefix, category, state) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = posixJoin(relPrefix, e.name);
    // Hidden entries (e.g. .twg-install.json, .DS_Store) = machine-local state.
    if (e.name.startsWith('.')) {
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
      if (e.name.endsWith('.lock') || e.name === 'package-lock.json') {
        state.skipped.push({ category, relPath: rel, reason: 'excluded' });
        continue;
      }
      addFile(abs, rel, category, state);
    }
  }
}

/** Extract path-like tokens from a settings command string. */
function extractPathTokens(cmd) {
  return String(cmd)
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter((t) => t.includes('/') || t.startsWith('~'));
}

/** Resolve a script token to an absolute path (expand ~, resolve against home). */
function resolveScriptToken(token, home) {
  if (!token) return null;
  let t = token;
  if (t === '~') t = home;
  else if (t.startsWith('~/')) t = join(home, t.slice(2));
  if (!isAbsolute(t)) t = resolve(home, t);
  return t;
}

/**
 * Discover scripts referenced by settings.json / settings.local.json
 * (statusLine.command + hooks[].hooks[].command). In-tree scripts (under
 * ~/.claude) are backed up under the `scripts` category; out-of-tree referenced
 * scripts are recorded in `skipped` (reason 'out-of-tree') — a known limitation.
 */
function collectReferencedScripts(claudeDir, home, state) {
  for (const sf of ['settings.json', 'settings.local.json']) {
    const p = join(claudeDir, sf);
    if (!existsSync(p)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }

    const commands = [];
    if (json.statusLine && typeof json.statusLine.command === 'string') {
      commands.push(json.statusLine.command);
    }
    const hooks = json.hooks || {};
    for (const event of Object.keys(hooks)) {
      const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
      for (const matcher of matchers) {
        for (const h of matcher?.hooks || []) {
          if (h && h.type === 'command' && typeof h.command === 'string') commands.push(h.command);
        }
      }
    }

    for (const cmd of commands) {
      for (const token of extractPathTokens(cmd)) {
        const abs = resolveScriptToken(token, home);
        if (!abs || !existsSync(abs)) continue;
        let isFile = false;
        try {
          isFile = statSync(abs).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) continue;

        const inTree = abs === claudeDir || abs.startsWith(claudeDir + sep);
        if (!inTree) {
          state.skipped.push({ category: 'scripts', relPath: abs, reason: 'out-of-tree' });
          continue;
        }
        addFile(abs, toPosix(relative(claudeDir, abs)), 'scripts', state);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// collectResources
// ---------------------------------------------------------------------------

/**
 * Collect ~/.claude custom assets into a bundle + content-free manifest.
 *
 * @param {object} [opts]
 * @param {string} [opts.home] - home dir (default os.homedir()); test injection
 * @param {string} [opts.claudeDir] - ~/.claude dir (default join(home, '.claude'))
 * @param {string|function} [opts.now] - ISO timestamp (or () => iso) for collectedAt
 * @param {string[]} [opts.categories] - PARTIAL backup: only collect these
 *   categories (`scripts` always rides along). Empty/undefined → collect all.
 * @returns {{
 *   bundle: string, manifest: string, checksum: string, fileCount: number,
 *   totalBytes: number, byCategory: Record<string, number>,
 *   redactions: Array<{relPath: string, count: number}>, redactedTotal: number,
 *   skipped: Array<{category: string, relPath: string, reason: string}>,
 *   collectedAt: string, files: Array<object>
 * }}
 */
export function collectResources(opts = {}) {
  const home = opts.home || homedir();
  const claudeDir = opts.claudeDir || join(home, '.claude');
  const now = opts.now
    ? typeof opts.now === 'function'
      ? opts.now()
      : opts.now
    : new Date().toISOString();

  // PARTIAL backup: restrict to selected categories (null → all). `scripts`
  // is not directly selectable — it always rides along with any subgroup.
  const selected =
    Array.isArray(opts.categories) && opts.categories.length > 0 ? new Set(opts.categories) : null;

  const state = { files: [], skipped: [], totalBytes: 0, seen: new Set() };

  // Single-file categories at the ~/.claude root.
  for (const [category, name] of FILE_CATEGORIES) {
    if (selected && !selected.has(category)) continue;
    const abs = join(claudeDir, name);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) addFile(abs, name, category, state);
    } catch {
      /* ignore */
    }
  }

  // Directory-rooted categories (recursive).
  for (const [category, dir] of DIR_CATEGORIES) {
    if (selected && !selected.has(category)) continue;
    const abs = join(claudeDir, dir);
    try {
      if (existsSync(abs) && statSync(abs).isDirectory()) walkDir(abs, dir, category, state);
    } catch {
      /* ignore */
    }
  }

  // settings-referenced scripts (in-tree only) — always collected (随行刷新).
  collectReferencedScripts(claudeDir, home, state);

  // Deterministic ordering → stable bundle/manifest/checksum across runs.
  const byRelPath = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  state.files.sort(byRelPath);
  state.skipped.sort(byRelPath);

  const fileCount = state.files.length;
  // Checksum over (relPath, per-file checksum) only — excludes collectedAt so an
  // unchanged tree yields a stable checksum and the server short-circuits.
  const checksum = checksumOf(JSON.stringify(state.files.map((f) => [f.relPath, f.checksum])));

  const manifestFiles = state.files.map(({ content, ...rest }) => rest);
  const bundle = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    agent: 'claude',
    collectedAt: now,
    checksum,
    files: state.files,
    skipped: state.skipped,
  });
  const manifest = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    agent: 'claude',
    collectedAt: now,
    fileCount,
    checksum,
    files: manifestFiles,
    skipped: state.skipped,
  });

  const redactions = state.files
    .filter((f) => f.redactedCount > 0)
    .map((f) => ({ relPath: f.relPath, count: f.redactedCount }));
  const redactedTotal = redactions.reduce((n, r) => n + r.count, 0);
  const byCategory = {};
  for (const f of state.files) byCategory[f.category] = (byCategory[f.category] || 0) + 1;

  return {
    bundle,
    manifest,
    checksum,
    fileCount,
    totalBytes: state.totalBytes,
    byCategory,
    redactions,
    redactedTotal,
    skipped: state.skipped,
    collectedAt: now,
    /** In-memory collected files (each with content); bundle/manifest are the serialized forms. */
    files: state.files,
  };
}
