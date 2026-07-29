/**
 * claude-json-backup.mjs — 本地 ~/.claude.json 读取与「精简」工具
 *
 * 专为 jira_backup_claude_config MCP 工具服务（APDEVIMP-6/7）：
 *  1. loadClaudeJson()  — 读取 ~/.claude.json
 *  2. slimClaudeJson(obj) — 深拷贝并剥离 cache/统计/一次性标志 + 整块丢弃 projects
 *
 * 密钥脱敏（redactSecrets）与校验和（checksumOf）复用 settings-backup.mjs，
 * 不在此重复实现 —— 本模块只负责「读取 + 精简」。
 *
 * 设计原则：纯函数（除 loadClaudeJson 文件 I/O），零外部依赖，易于测试注入。
 *
 * ~/.claude.json 承载「全局状态 / 账号 / user 作用域 MCP」，但同时混入大量
 * 运行期缓存与统计（`*Cache` / `cached*`、`hasSeen*` 一次性标志、`tipsHistory`
 * 使用历史）以及体量很大的 per-project `projects` 块（含 history）。备份时只保留
 * 「全局状态 / 账号 / user 作用域 MCP」相关字段。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认 ~/.claude.json 路径 */
const DEFAULT_CLAUDE_JSON_PATH = join(homedir(), '.claude.json');

/** 顶层键名命中即整体剥离的正则（缓存类） */
const CACHE_KEY_PATTERN = /cache/i;

/** 顶层键名命中即剥离的一次性提示/引导标志 */
const ONE_TIME_FLAG_PATTERN = /^hasSeen/;

/**
 * 精确匹配整块丢弃的顶层键：
 *  - projects：per-project 状态（含 history），不属「全局/user 作用域」，且体量巨大
 *  - tipsHistory：提示使用历史（统计类）
 */
const BLOCK_DROP_KEYS = new Set(['projects', 'tipsHistory']);

// ---------------------------------------------------------------------------
// loadClaudeJson
// ---------------------------------------------------------------------------

/**
 * 读取 ~/.claude.json（或通过 opts.file 注入路径，便于测试）。
 *
 * @param {object} [opts]
 * @param {string} [opts.file] - 注入文件路径（测试用）；默认 DEFAULT_CLAUDE_JSON_PATH
 * @returns {Promise<{ path: string, json: object|null, exists: boolean }>}
 * @throws {Error} 文件存在但 JSON 无效时抛出清晰错误
 */
export async function loadClaudeJson(opts = {}) {
  const filePath = opts.file || DEFAULT_CLAUDE_JSON_PATH;

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { path: filePath, json: null, exists: false };
    }
    throw err;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Failed to parse JSON in ${filePath}: ${parseErr.message}`);
  }

  return { path: filePath, json, exists: true };
}

// ---------------------------------------------------------------------------
// slimClaudeJson
// ---------------------------------------------------------------------------

/**
 * 深拷贝 obj 并剥离 cache/统计/一次性标志类的顶层键，整块丢弃 projects。
 *
 * 剥离规则（仅作用于顶层键）：
 *  - 键名命中 /cache/i（覆盖 `*Cache` 与 `cached*`）
 *  - 键名命中 /^hasSeen/（一次性提示/引导标志）
 *  - 键名 ∈ {projects, tipsHistory}（per-project 块 / 使用历史统计）
 *
 * 其余键（numStartups、installMethod、oauthAccount、primaryApiKey、mcpServers…）原样保留。
 * 不修改原对象（纯函数）。
 *
 * @param {object} obj - 原始 .claude.json 对象
 * @returns {{ slimmed: object, removedKeys: string[] }} removedKeys 为被剥离的顶层键名（用于 dry-run 预览）
 */
export function slimClaudeJson(obj) {
  const slimmed = {};
  const removedKeys = [];

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    // 非对象输入：原样深拷贝返回，removedKeys 为空
    return { slimmed: deepCopy(obj), removedKeys };
  }

  for (const key of Object.keys(obj)) {
    if (
      CACHE_KEY_PATTERN.test(key) ||
      ONE_TIME_FLAG_PATTERN.test(key) ||
      BLOCK_DROP_KEYS.has(key)
    ) {
      removedKeys.push(key);
      continue;
    }
    slimmed[key] = deepCopy(obj[key]);
  }

  return { slimmed, removedKeys };
}

/**
 * 简单深拷贝（JSON 安全结构，不含函数/循环引用）。
 *
 * @param {*} v
 * @returns {*}
 */
function deepCopy(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}
