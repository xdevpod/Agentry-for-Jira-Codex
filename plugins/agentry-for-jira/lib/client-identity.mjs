/**
 * client-identity.mjs — derive a stable AI-terminal identity, locally, with
 * zero secrets.
 *
 * An AI terminal = one (machine × AI client). Its clientId is DETERMINISTICALLY
 * derived from clientType + osType + osUsername + machineId:
 *
 *   shortHash = sha256(`${clientType}|${osType}|${osUsername}|${machineId}`).slice(0,16)
 *   clientId  = `${clientType}-${osType}-${sanitize(osUsername)}-${shortHash}`
 *
 * Properties: recomputable (survives `rm -rf ~/.claude`), no timestamp, no
 * accountId. machineId ONLY feeds the hash — it is never returned, sent, or
 * stored. osUsername appears in plaintext in the prefix (low-sensitivity, by
 * design, for human readability).
 *
 * All OS/exec/fs entry points are injectable so the logic is unit-tested
 * without touching the real machine.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir, platform, hostname, arch, release, userInfo, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfigFile, saveConfigFile } from './secrets.mjs';
import { MACHINE_ID_FILE } from './paths.mjs';

/** The AI client type this plugin represents. Part of the terminal identity. */
export const CLIENT_TYPE = 'claude-code';

// MACHINE_ID_FILE imported from ./paths.mjs (~/.agentry-for-jira/machine-id; auto-migrated).

/** Lowercase + collapse to [a-z0-9-] so osUsername is safe in a KVS key / PK. */
export function sanitizeUsername(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'unknown';
}

/**
 * Read the OS-level stable machine fingerprint (readable by a normal user, no
 * sudo). darwin → IOPlatformUUID; linux → /etc/machine-id; win32 → MachineGuid.
 * Falls back to a write-once random UUID when unavailable. The result ONLY ever
 * feeds the clientId hash.
 *
 * @param {object} [opts] injectable execFileSync / platform / machineIdFile / randomUUID
 */
export function getMachineId(opts = {}) {
  const exec = opts.execFileSync || execFileSync;
  const plat = opts.platform || platform();
  try {
    if (plat === 'darwin') {
      const out = exec('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m && m[1]) return m[1];
    } else if (plat === 'linux') {
      const read = opts.readFileSync || readFileSync;
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = read(p, 'utf8').trim();
          if (id) return id;
        } catch {
          /* try next */
        }
      }
    } else if (plat === 'win32') {
      const out = exec('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      if (m && m[1]) return m[1];
    }
  } catch {
    /* fall through to the persisted-UUID fallback */
  }
  return fallbackMachineId(opts);
}

/** Persisted random UUID fallback (write-once). machineId stays stable across runs. */
function fallbackMachineId(opts = {}) {
  const file = opts.machineIdFile || MACHINE_ID_FILE;
  try {
    if (existsSync(file)) {
      const id = readFileSync(file, 'utf8').trim();
      if (id) return id;
    }
  } catch {
    /* unreadable → regenerate */
  }
  const id = (opts.randomUUID || randomUUID)();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, id, 'utf8');
    chmodSync(file, 0o600);
  } catch {
    /* best-effort persistence; a fresh UUID each run is the degraded case */
  }
  return id;
}

/**
 * Deterministically derive the clientId. machineId is hashed, never emitted.
 * @param {{clientType:string, osType:string, osUsername:string, machineId:string}} p
 */
export function computeClientId({ clientType, osType, osUsername, machineId }) {
  const shortHash = createHash('sha256')
    .update(`${clientType}|${osType}|${osUsername}|${machineId}`)
    .digest('hex')
    .slice(0, 16);
  return `${clientType}-${osType}-${sanitizeUsername(osUsername)}-${shortHash}`;
}

/** First non-internal IPv4 across all interfaces, or '' when none/disabled. */
export function firstLanIPv4(ifaces) {
  const nets = ifaces || networkInterfaces();
  for (const name of Object.keys(nets || {})) {
    for (const ni of nets[name] || []) {
      // Node ≥18 reports family as number 4; older as string 'IPv4'.
      const isV4 = ni.family === 'IPv4' || ni.family === 4;
      if (isV4 && !ni.internal && ni.address) return ni.address;
    }
  }
  return '';
}

/**
 * Collect mutable terminal metadata via node `os`. Never includes machineId.
 * IP collection is on by default (LAN IPv4, best-effort) and disabled with
 * JIRA_COLLECT_IP=false.
 */
export function collectClientMetadata(opts = {}) {
  const env = opts.env || process.env;
  const osPlatform = opts.platform || platform();
  const getUser = opts.userInfo || userInfo;
  const getHost = opts.hostname || hostname;
  const osUsername = getUser().username;
  const host = getHost();
  const collectIp = env.JIRA_COLLECT_IP !== 'false';
  const ifaces = opts.networkInterfaces ? opts.networkInterfaces() : undefined;
  // Allow agent adapters to override the client type/version. When absent,
  // these default to the original Claude behavior (CLIENT_TYPE constant +
  // CLAUDE_CODE_VERSION env), so existing callers are unchanged.
  const clientType = opts.clientType || CLIENT_TYPE;
  const clientVersion = opts.clientVersion !== undefined
    ? opts.clientVersion
    : (env.CLAUDE_CODE_VERSION || env.CLAUDE_CODE_ENTRYPOINT_VERSION || 'unknown');

  return {
    clientType,
    osType: osPlatform,
    osUsername,
    hostname: host,
    arch: (opts.arch || arch)(),
    osVersion: (opts.release || release)(),
    ipAddress: collectIp ? firstLanIPv4(ifaces) : '',
    clientVersion,
    displayName: `${host} · ${clientType}`,
  };
}

/**
 * Resolve { clientId, metadata } for the current terminal. The clientId is
 * cached (non-secret, deterministic) in config.json — PER clientType — to avoid
 * re-running ioreg/reg on every push; absent → compute + cache.
 *
 * Per-agent caching is critical: a Claude terminal and a Codex terminal on the
 * SAME machine have DIFFERENT clientIds (clientType feeds both the prefix and
 * the hash). A single shared cache slot would let the second agent reuse the
 * first's clientId and overwrite its server-side terminal record.
 *
 * @param {object} [opts] injection for tests (configPath / config / os / exec)
 */
export function resolveClientIdentity(opts = {}) {
  const configPath = opts.configPath;
  const config = opts.config || loadConfigFile(configPath);
  const metadata = collectClientMetadata(opts);

  const cacheKey = clientCacheKey(metadata.clientType);
  let clientId = config[cacheKey];
  if (!clientId) {
    const machineId = getMachineId(opts);
    clientId = computeClientId({
      clientType: metadata.clientType,
      osType: metadata.osType,
      osUsername: metadata.osUsername,
      machineId,
    });
    try {
      saveConfigFile({ ...config, [cacheKey]: clientId }, configPath);
    } catch {
      /* caching is best-effort; clientId is recomputable next time */
    }
  }

  return { clientId, metadata };
}

/** Config key under which a given clientType's clientId is cached (per-agent slots). */
export function clientCacheKey(clientType) {
  return 'JIRA_CLIENT_ID_' + String(clientType || '').toUpperCase().replace(/[^A-Z0-9]/gi, '_');
}
