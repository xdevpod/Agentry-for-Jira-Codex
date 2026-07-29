/**
 * plugins-backup.mjs — 采集 ~/.claude/plugins 下的「插件清单 + 市场源」两份 JSON，
 * 打包成一个 bundle（APDEVIMP-20）。
 *
 * 备份对象（仅这两份，均可读、体量小）：
 *   - installed_plugins.json  (version:2；plugins 按「插件名@市场」分组)
 *   - known_marketplaces.json (按市场名分组；source=github repo / directory path)
 *
 * 明确排除（据清单可重建，故不备份）：
 *   plugins/{cache,repos,marketplaces,data}、plugin-catalog-cache.json、*.bak
 * 本模块只读取上面两个具名文件，排除是「构造式」的 —— 从不进入被排除目录。
 * EXCLUDED 常量仅用于 dryRun / 结果说明（AC 场景二）。
 *
 * 与 claude-json-backup 对齐：读取 →（脱敏，本场景基本无密钥）→ 规范化 bundle
 * → checksum（对「规范化内容」计算，排除 collectedAt，内容未变时稳定，服务端短路
 * unchanged）。密钥脱敏与 checksum 复用 settings-backup.mjs。
 *
 * 设计原则：纯函数（除 loadPluginManifests 文件 I/O），零外部依赖，可注入路径，易测。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { redactSecrets, checksumOf } from './settings-backup.mjs';

/** Bundle schema version. */
export const SCHEMA_VERSION = '1';

/** 默认 ~/.claude/plugins 目录 */
const DEFAULT_PLUGINS_DIR = join(homedir(), '.claude', 'plugins');

/** 两份备份对象的文件名 */
const INSTALLED_PLUGINS_FILE = 'installed_plugins.json';
const KNOWN_MARKETPLACES_FILE = 'known_marketplaces.json';

/** 明确排除项（据清单可重建，故不备份）—— 仅用于说明/预览。 */
export const EXCLUDED = [
  'plugins/cache',
  'plugins/repos',
  'plugins/marketplaces',
  'plugins/data',
  'plugin-catalog-cache.json',
  '*.bak',
];

/** 读取单个 JSON 文件；不存在返回 {exists:false}；解析失败抛出清晰错误。 */
function readJsonFile(abs) {
  if (!existsSync(abs)) return { exists: false, json: null, sizeBytes: 0 };
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, json: null, sizeBytes: 0 };
    throw err;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (parseErr) {
    throw new Error(`Failed to parse JSON in ${abs}: ${parseErr.message}`);
  }
  return { exists: true, json, sizeBytes: Buffer.byteLength(raw, 'utf8') };
}

/**
 * 读取两份插件清单。
 *
 * @param {object} [opts] - { pluginsDir? } 注入目录（测试用）；默认 ~/.claude/plugins
 * @returns {{ pluginsDir: string,
 *   installedPlugins: { exists: boolean, json: object|null, sizeBytes: number, path: string },
 *   knownMarketplaces: { exists: boolean, json: object|null, sizeBytes: number, path: string } }}
 */
export function loadPluginManifests(opts = {}) {
  const pluginsDir = opts.pluginsDir || DEFAULT_PLUGINS_DIR;
  const ipPath = join(pluginsDir, INSTALLED_PLUGINS_FILE);
  const kmPath = join(pluginsDir, KNOWN_MARKETPLACES_FILE);
  return {
    pluginsDir,
    installedPlugins: { ...readJsonFile(ipPath), path: ipPath },
    knownMarketplaces: { ...readJsonFile(kmPath), path: kmPath },
  };
}

/** 统计已装插件数（installed_plugins.json 的 plugins 键数）。 */
function countPlugins(installedJson) {
  const plugins = installedJson && installedJson.plugins;
  return plugins && typeof plugins === 'object' ? Object.keys(plugins).length : 0;
}

/** 统计市场源数（known_marketplaces.json 顶层键数）。 */
function countMarketplaces(marketplacesJson) {
  return marketplacesJson && typeof marketplacesJson === 'object'
    ? Object.keys(marketplacesJson).length
    : 0;
}

/**
 * 由两份清单构造 bundle + 元信息。
 *
 * @param {object} args
 * @param {object|null} args.installedPlugins - 解析后的 installed_plugins.json（或 null）
 * @param {object|null} args.knownMarketplaces - 解析后的 known_marketplaces.json（或 null）
 * @param {Array<{name:string,exists:boolean,sizeBytes:number}>} args.files - provenance
 * @param {string} args.now - collectedAt ISO 时间戳
 * @returns {{ bundle: string, content: string, checksum: string, pluginCount: number,
 *   marketplaceCount: number, redactedKeys: string[], files: Array, excluded: string[] }}
 */
export function buildPluginsBundle(args) {
  const { installedPlugins, knownMarketplaces, files, now } = args;

  // 脱敏（本场景基本无密钥；对齐管线，通常为 no-op）。
  const ip = installedPlugins ? redactSecrets(installedPlugins) : { sanitized: null, redactedKeys: [] };
  const km = knownMarketplaces ? redactSecrets(knownMarketplaces) : { sanitized: null, redactedKeys: [] };
  const redactedKeys = [...ip.redactedKeys, ...km.redactedKeys];

  const pluginCount = countPlugins(ip.sanitized);
  const marketplaceCount = countMarketplaces(km.sanitized);

  // checksum 对「规范化内容」计算（排除 collectedAt），内容未变时稳定 → 服务端短路。
  const checksum = checksumOf(
    JSON.stringify({ installedPlugins: ip.sanitized, knownMarketplaces: km.sanitized })
  );

  const bundle = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    agent: 'claude',
    collectedAt: now,
    checksum,
    pluginCount,
    marketplaceCount,
    installedPlugins: ip.sanitized,
    knownMarketplaces: km.sanitized,
    files,
    excluded: EXCLUDED,
  });

  return {
    bundle,
    content: bundle,
    checksum,
    pluginCount,
    marketplaceCount,
    redactedKeys,
    files,
    excluded: EXCLUDED,
  };
}

/**
 * 采集本机插件/市场清单为一个 bundle（loadPluginManifests + buildPluginsBundle 组合）。
 *
 * @param {object} [opts] - { pluginsDir?, now? }
 * @returns {{ bundle, content, checksum, pluginCount, marketplaceCount, redactedKeys,
 *   files, excluded, present: boolean }} present=false → 两份清单都不存在（无可备份）。
 */
export function collectPlugins(opts = {}) {
  const now = opts.now
    ? typeof opts.now === 'function' ? opts.now() : opts.now
    : new Date().toISOString();
  const { installedPlugins, knownMarketplaces } = loadPluginManifests(opts);

  const files = [
    { name: INSTALLED_PLUGINS_FILE, exists: installedPlugins.exists, sizeBytes: installedPlugins.sizeBytes },
    { name: KNOWN_MARKETPLACES_FILE, exists: knownMarketplaces.exists, sizeBytes: knownMarketplaces.sizeBytes },
  ];
  const present = installedPlugins.exists || knownMarketplaces.exists;

  const built = buildPluginsBundle({
    installedPlugins: installedPlugins.json,
    knownMarketplaces: knownMarketplaces.json,
    files,
    now,
  });

  return { ...built, present };
}
