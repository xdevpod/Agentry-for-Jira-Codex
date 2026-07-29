/**
 * codex-config-backup.mjs — 本地 ~/.codex/config.toml 读取与密钥脱敏
 *
 * 专为 jira_backup_codex_config MCP 工具服务：
 *  1. loadCodexConfig()    — 读取 $CODEX_HOME/config.toml（默认 ~/.codex/config.toml）
 *  2. redactTomlSecrets(text) — 按行扫描，把命中密钥名的 quoted-string 赋值替换为 <REDACTED>
 *
 * 与 settings-backup / claude-json-backup 的关键差异：
 *  - config.toml 是 TOML 文本（非 JSON），插件零依赖、不引入 TOML parser。
 *    故「读取」返回原始文本，「脱敏」作用于文本（保留 TOML 原始格式，最利于展示/下载），
 *    服务端按格式无关的 string blob 存储。
 *  - config.toml 体量小且全是配置（无 cache/统计/projects 之类噪音），故无 slim 步骤。
 *  - 密钥判定复用 settings-backup.mjs 的 isSecretKey（单一真相源）。
 *
 * 设计原则：纯函数（除 loadCodexConfig 文件 I/O），零外部依赖，易于测试注入。
 *
 * TOML 里密钥值几乎总是带引号的字符串，形如 `KEY = "value"`。standalone 赋值与 inline
 * table `env = { K = "v" }` 内部条目同形，故一次正则扫描即可覆盖两者。逐行处理以附带
 * table 路径（如 mcp_servers.jira-sync.env.SOME_TOKEN）用于 dry-run 报告。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isSecretKey } from './settings-backup.mjs';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 脱敏后的占位值 */
const REDACTED = '<REDACTED>';

/**
 * 匹配 bare key + 带引号字符串赋值：`KEY = "..."` 或 `KEY = '...'`。
 * 捕获组：1=键名，2=双引号内内容（无引号），3=单引号内内容（无引号）。
 * 仅匹配带引号的字符串值——数字/布尔/数组不会被误命中（它们不是密钥载体）。
 */
const ASSIGN_QUOTED = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;

// ---------------------------------------------------------------------------
// loadCodexConfig
// ---------------------------------------------------------------------------

/** 默认 config.toml 路径：$CODEX_HOME/config.toml（缺省 ~/.codex/config.toml）。 */
function defaultCodexConfigPath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'config.toml');
}

/**
 * 读取 ~/.codex/config.toml（或通过 opts.file 注入路径，便于测试）。
 * 返回原始文本（不解析 TOML）；文件不存在时 exists:false。
 *
 * @param {object} [opts]
 * @param {string} [opts.file] - 注入文件路径（测试用）；默认 $CODEX_HOME/config.toml
 * @returns {Promise<{ path: string, text: string|null, exists: boolean }>}
 */
export async function loadCodexConfig(opts = {}) {
  const filePath = opts.file || defaultCodexConfigPath();

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { path: filePath, text: null, exists: false };
    }
    throw err;
  }

  return { path: filePath, text, exists: true };
}

// ---------------------------------------------------------------------------
// redactTomlSecrets
// ---------------------------------------------------------------------------

/**
 * 从 TOML 表头行（`[a.b.c]` 或 `[[a.b]]`）提取路径，用于 redactedKeys 的上下文。
 * 返回 null 表示该行不是表头。
 */
function tablePathFromHeader(line) {
  const m = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+/);
  if (!m) return null;
  // 形如 mcp_servers.jira-sync.env 或 projects."/some/path"——剥掉整体外层引号（罕见）
  return m[1].replace(/^["']|["']$/g, '');
}

/**
 * 按行扫描 TOML 文本，把命中密钥名的 quoted-string 赋值替换为 <REDACTED>。
 * 同时覆盖 standalone 赋值与 inline table（env = { K = "v" }）内部条目。
 *
 * 规则：
 *  - 仅替换值，保留键名、等号、引号风格（双/单引号）
 *  - 键名经 isSecretKey 判定（与 settings 脱敏同一规则）
 *  - redactedKeys 带 table 路径前缀（如 mcp_servers.jira-sync.env.TOKEN）
 *  - 非 quoted 值（数字/布尔/数组）不匹配、不动
 *  - 纯函数：不修改入参
 *
 * @param {string} text - 原始 config.toml 文本
 * @returns {{ sanitized: string, redactedKeys: string[] }}
 */
export function redactTomlSecrets(text) {
  const redactedKeys = [];
  const lines = String(text).split(/\r?\n/);
  let currentPath = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headerPath = tablePathFromHeader(line);
    if (headerPath !== null) {
      currentPath = headerPath;
      continue;
    }

    // 重置正则 lastIndex（/g + 循环复用需手动重置）
    ASSIGN_QUOTED.lastIndex = 0;
    lines[i] = line.replace(ASSIGN_QUOTED, (match, key, dq, sq) => {
      if (!isSecretKey(key)) return match;
      const quote = dq !== undefined ? '"' : "'";
      redactedKeys.push(currentPath ? `${currentPath}.${key}` : key);
      return `${key} = ${quote}${REDACTED}${quote}`;
    });
  }

  return { sanitized: lines.join('\n'), redactedKeys };
}
