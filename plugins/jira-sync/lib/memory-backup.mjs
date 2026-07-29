/**
 * memory-backup.mjs — 采集 Claude Code 的「记忆」文件，打包成 bundle + manifest。
 *
 * 专为 jira_backup_memory MCP 工具服务（APDEVIMP-23）。把「记忆」从 resources 备份
 * 中拆出，独立成一条平行切片（镜像 resource-backup）。三类记忆，每个文件带 `group`
 * 分组键，供查看页按项目 / 按 agent 类型分组：
 *   - user-memory    : ~/.claude/CLAUDE.md（用户级全局记忆 / 指令；group 空）
 *   - project-memory : ~/.claude/projects/<项目目录名>/memory/**（memdir：MEMORY.md
 *                      索引 + 各 topic *.md；group = 项目目录名 sanitized git root）
 *   - agent-memory   : ~/.claude/agent-memory/<agentType>/**（user 作用域子代理持久
 *                      记忆；group = agentType）
 *
 * 作用域提示（AC 场景四，探测但**不采集**）：project / local 作用域的 agent-memory
 *   （~/.claude/projects/<proj>/agent-memory/、agent-memory-local/）记入 skipped
 *   （reason 'scope-optional'），由用户决定是否纳入个人备份。
 *
 * 边界排除（AC 场景五）：会话 transcript（*.jsonl）与 session-memory —— 属「会话历史」
 *   范畴，不在本切片。由于只遍历 memory/ 与 agent-memory/<type>/ 子树，transcript
 *   （projects/<proj>/*.jsonl）与 session-memory（projects/<proj>/<sessionId>/…）天然
 *   不被触及；walkDir 内另有 .jsonl 兜底跳过。
 *
 * 安全：脱敏在客户端完成（JSON 键级 redactSecrets + 值级 scanTextSecrets）。去重
 *   checksum 只对 (relPath, per-file checksum) 计算，不含 collectedAt → 内容未变时
 *   checksum 稳定，服务端可短路 unchanged。
 *
 * 设计原则：纯函数 + 可注入（home / claudeDir / now），零外部依赖，易于测试。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { redactSecrets, checksumOf } from './settings-backup.mjs';
import { scanTextSecrets } from './resource-backup.mjs';

/** Bundle schema version. */
export const SCHEMA_VERSION = '1';

/** Per-file byte ceiling — larger files are skipped (recorded in `skipped`). */
const PER_FILE_MAX = 256 * 1024;
/** Total bundle byte budget — files beyond it are skipped (recorded). */
const TOTAL_MAX = 5 * 1024 * 1024;

/** Directory names never backed up (machine-local / VCS noise). */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * project / local 作用域 agent-memory 目录名。它们若出现在
 * ~/.claude/projects/<proj>/ 下，仅作为 scope-optional 提示，不采集。
 */
const OPTIONAL_SCOPE_DIRS = ['agent-memory', 'agent-memory-local'];

// ---------------------------------------------------------------------------
// 内部工具（与 resource-backup 同构，另加 group 维度）
// ---------------------------------------------------------------------------

/** Join path segments with POSIX separators (stable relPath across OSes). */
function posixJoin(...parts) {
  return parts.filter(Boolean).join('/');
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
 * otherwise redact + push it to `state.files` with its category + group.
 */
function addFile(abs, relPath, category, group, state) {
  if (state.seen.has(relPath)) return;

  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return; // unreadable → silently ignore
  }

  if (buf.includes(0)) {
    state.skipped.push({ category, group, relPath, reason: 'binary' });
    return;
  }
  if (buf.length > PER_FILE_MAX) {
    state.skipped.push({ category, group, relPath, reason: 'too-large', sizeBytes: buf.length });
    return;
  }
  if (state.totalBytes + buf.length > TOTAL_MAX) {
    state.skipped.push({ category, group, relPath, reason: 'budget-exceeded', sizeBytes: buf.length });
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
    group,
    relPath,
    type,
    sizeBytes,
    checksum: checksumOf(content),
    mode,
    redactedCount,
    content,
  });
}

/** Recursively walk a memory directory, skipping hidden / state / VCS noise. */
function walkDir(absDir, relPrefix, category, group, state) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = posixJoin(relPrefix, e.name);
    // Hidden entries (e.g. .DS_Store) = machine-local state.
    if (e.name.startsWith('.')) {
      state.skipped.push({ category, group, relPath: rel, reason: 'excluded' });
      continue;
    }
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || /cache/i.test(e.name)) {
        state.skipped.push({ category, group, relPath: rel, reason: 'excluded' });
        continue;
      }
      walkDir(abs, rel, category, group, state);
    } else if (e.isFile()) {
      // Boundary exclusion: transcripts are session history, never memory.
      if (e.name.endsWith('.jsonl')) continue;
      if (e.name.endsWith('.lock')) {
        state.skipped.push({ category, group, relPath: rel, reason: 'excluded' });
        continue;
      }
      addFile(abs, rel, category, group, state);
    }
  }
}

/** Immediate subdirectory names of a dir (empty array if missing/unreadable). */
function listSubDirs(absDir) {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// collectMemory
// ---------------------------------------------------------------------------

/**
 * Collect Claude Code memory files into a bundle + content-free manifest.
 *
 * @param {object} [opts]
 * @param {string} [opts.home] - home dir (default os.homedir()); test injection
 * @param {string} [opts.claudeDir] - ~/.claude dir (default join(home, '.claude'))
 * @param {string|function} [opts.now] - ISO timestamp (or () => iso) for collectedAt
 * @returns {{
 *   bundle: string, manifest: string, checksum: string, fileCount: number,
 *   totalBytes: number, byCategory: Record<string, number>,
 *   byGroup: Record<string, Record<string, number>>,
 *   redactions: Array<{relPath: string, count: number}>, redactedTotal: number,
 *   skipped: Array<{category: string, group: string, relPath: string, reason: string}>,
 *   collectedAt: string, files: Array<object>
 * }}
 */
export function collectMemory(opts = {}) {
  const home = opts.home || homedir();
  const claudeDir = opts.claudeDir || join(home, '.claude');
  const now = opts.now
    ? typeof opts.now === 'function'
      ? opts.now()
      : opts.now
    : new Date().toISOString();

  const state = { files: [], skipped: [], totalBytes: 0, seen: new Set() };

  // 1. 用户记忆 — ~/.claude/CLAUDE.md
  const claudeMd = join(claudeDir, 'CLAUDE.md');
  try {
    if (existsSync(claudeMd) && statSync(claudeMd).isFile()) {
      addFile(claudeMd, 'CLAUDE.md', 'user-memory', '', state);
    }
  } catch {
    /* ignore */
  }

  // 2. 项目自动记忆 — ~/.claude/projects/<proj>/memory/**（按项目分组）
  //    并探测（不采集）project/local 作用域 agent-memory → scope-optional。
  const projectsDir = join(claudeDir, 'projects');
  for (const proj of listSubDirs(projectsDir)) {
    const memDir = join(projectsDir, proj, 'memory');
    try {
      if (existsSync(memDir) && statSync(memDir).isDirectory()) {
        walkDir(memDir, posixJoin('projects', proj, 'memory'), 'project-memory', proj, state);
      }
    } catch {
      /* ignore */
    }
    for (const opt of OPTIONAL_SCOPE_DIRS) {
      const optDir = join(projectsDir, proj, opt);
      try {
        if (existsSync(optDir) && statSync(optDir).isDirectory()) {
          state.skipped.push({
            category: 'agent-memory',
            group: proj,
            relPath: posixJoin('projects', proj, opt),
            reason: 'scope-optional',
          });
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 3. Agent 自动记忆（user 作用域）— ~/.claude/agent-memory/<agentType>/**
  const agentMemDir = join(claudeDir, 'agent-memory');
  for (const agentType of listSubDirs(agentMemDir)) {
    walkDir(
      join(agentMemDir, agentType),
      posixJoin('agent-memory', agentType),
      'agent-memory',
      agentType,
      state
    );
  }

  // Deterministic ordering → stable bundle/manifest/checksum across runs.
  const byRelPath = (a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  state.files.sort(byRelPath);
  state.skipped.sort(byRelPath);

  const fileCount = state.files.length;
  // Checksum over (relPath, per-file checksum) only — excludes collectedAt so an
  // unchanged tree yields a stable checksum and the server short-circuits.
  const checksum = checksumOf(JSON.stringify(state.files.map((f) => [f.relPath, f.checksum])));

  const byCategory = {};
  for (const f of state.files) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  // byGroup: category → group → count (drives the view's project / agent grouping).
  const byGroup = {};
  for (const f of state.files) {
    if (!f.group) continue;
    byGroup[f.category] = byGroup[f.category] || {};
    byGroup[f.category][f.group] = (byGroup[f.category][f.group] || 0) + 1;
  }

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
    byCategory,
    byGroup,
    files: manifestFiles,
    skipped: state.skipped,
  });

  const redactions = state.files
    .filter((f) => f.redactedCount > 0)
    .map((f) => ({ relPath: f.relPath, count: f.redactedCount }));
  const redactedTotal = redactions.reduce((n, r) => n + r.count, 0);

  return {
    bundle,
    manifest,
    checksum,
    fileCount,
    totalBytes: state.totalBytes,
    byCategory,
    byGroup,
    redactions,
    redactedTotal,
    skipped: state.skipped,
    collectedAt: now,
    /** In-memory collected files (each with content); bundle/manifest are the serialized forms. */
    files: state.files,
  };
}
