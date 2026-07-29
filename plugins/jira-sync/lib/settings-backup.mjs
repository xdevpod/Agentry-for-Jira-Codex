/**
 * settings-backup.mjs — 本地 settings.json 读取、密钥脱敏和校验和工具
 *
 * 专为 jira_backup_user_settings MCP 工具服务：
 *  1. loadLocalSettings()  — 读取 ~/.claude/settings.json
 *  2. redactSecrets(obj)   — 深拷贝并递归脱敏疑似密钥的叶子值
 *  3. checksumOf(str)      — 计算 sha256 hex 校验和（上传前去重）
 *
 * 设计原则：纯函数（除 loadLocalSettings 文件 I/O），零外部依赖，易于测试注入。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认 settings 文件路径 */
const DEFAULT_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/**
 * 命中此正则（键名小写后匹配）的叶子值将被替换为 ***REDACTED***
 * 覆盖场景：token、secret、password/passwd、credential、apikey、api_key、
 *           api-key、access_key、access-key、private_key、private-key
 */
const SECRET_KEY_PATTERN = /(token|secret|passwd|password|credential|apikey|api[_-]?key|access[_-]?key|private[_-]?key)/i;

/**
 * 精确匹配例外：这些键名即使命中上述正则也不脱敏（误报）
 *  - apiKeyHelper：实际上是命令路径，不是密钥值
 *  - claudeCodeFirstTokenDate：是时间戳（含 "Token" 子串），非密钥（.claude.json 全局状态）
 */
const EXACT_EXCEPTIONS = new Set(['apiKeyHelper', 'claudeCodeFirstTokenDate']);

/**
 * 整块跳过的顶层键（递归中不进入）：
 *  - permissions：allow/deny/ask 策略必须原样保留
 */
const BLOCK_SKIP_KEYS = new Set(['permissions']);

/**
 * 判定一个键名是否应被视为密钥（命中 SECRET_KEY_PATTERN 且不在 EXACT_EXCEPTIONS 中）。
 * 单一真相源：对象脱敏（redactSecrets）与 TOML 文本脱敏（redactTomlSecrets）共用此判定。
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  if (!key) return false;
  if (EXACT_EXCEPTIONS.has(key)) return false;
  return SECRET_KEY_PATTERN.test(String(key).toLowerCase());
}

// ---------------------------------------------------------------------------
// loadLocalSettings
// ---------------------------------------------------------------------------

/**
 * 读取 ~/.claude/settings.json（或通过 opts.file 注入路径，便于测试）。
 *
 * @param {object} [opts]
 * @param {string} [opts.file] - 注入文件路径（测试用）；默认 DEFAULT_SETTINGS_PATH
 * @returns {Promise<{ path: string, json: object|null, exists: boolean }>}
 * @throws {Error} 文件存在但 JSON 无效时抛出清晰错误
 */
export async function loadLocalSettings(opts = {}) {
  const filePath = opts.file || DEFAULT_SETTINGS_PATH;

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
    throw new Error(
      `Failed to parse JSON in ${filePath}: ${parseErr.message}`
    );
  }

  return { path: filePath, json, exists: true };
}

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

/**
 * 深拷贝 obj 并递归脱敏疑似密钥的叶子字符串值。
 *
 * 规则：
 * - 仅对叶子值（非对象、非数组）操作
 * - 键名小写后命中 SECRET_KEY_PATTERN 则脱敏
 * - EXACT_EXCEPTIONS 中的键名不脱敏
 * - BLOCK_SKIP_KEYS 整块跳过（permissions 等）
 * - 返回 { sanitized, redactedKeys: string[] }（点路径如 env.ANTHROPIC_API_KEY）
 * - 不修改原对象（纯函数）
 *
 * @param {object} obj - 原始对象
 * @returns {{ sanitized: object, redactedKeys: string[] }}
 */
export function redactSecrets(obj) {
  const redactedKeys = [];
  const sanitized = deepRedact(obj, '', redactedKeys);
  return { sanitized, redactedKeys };
}

/**
 * 递归深拷贝并脱敏内部实现。
 *
 * @param {*} value - 当前节点值
 * @param {string} path - 当前点路径（根为空字符串）
 * @param {string[]} redactedKeys - 收集命中的路径
 * @returns {*} 深拷贝后（可能脱敏）的值
 */
function deepRedact(value, path, redactedKeys) {
  // 非对象（含 null）直接返回
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // 数组：递归每个元素（数组不按键名脱敏）
  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      deepRedact(item, path ? `${path}[${idx}]` : `[${idx}]`, redactedKeys)
    );
  }

  // 普通对象：逐键处理
  const result = {};
  for (const key of Object.keys(value)) {
    const childPath = path ? `${path}.${key}` : key;

    // 整块跳过键（permissions 等）
    if (BLOCK_SKIP_KEYS.has(key)) {
      result[key] = deepCopy(value[key]);
      continue;
    }

    const childValue = value[key];

    // 叶子值 + 命中规则 → 脱敏
    if (
      childValue !== null &&
      typeof childValue !== 'object' &&
      isSecretKey(key)
    ) {
      result[key] = '***REDACTED***';
      redactedKeys.push(childPath);
      continue;
    }

    // 否则递归
    result[key] = deepRedact(childValue, childPath, redactedKeys);
  }
  return result;
}

/**
 * 简单深拷贝（JSON 安全结构，不含函数/循环引用）。
 * 用于 BLOCK_SKIP_KEYS 整块保留时确保不共享引用。
 *
 * @param {*} v
 * @returns {*}
 */
function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// checksumOf
// ---------------------------------------------------------------------------

/**
 * 计算字符串的 sha256 hex 校验和。
 * 用于上传前去重：服务端比较 checksum，内容未变时返回 unchanged:true。
 *
 * @param {string} str - 待校验的字符串（通常是 JSON.stringify 后的 content）
 * @returns {string} 64 位小写 hex 字符串
 */
export function checksumOf(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
