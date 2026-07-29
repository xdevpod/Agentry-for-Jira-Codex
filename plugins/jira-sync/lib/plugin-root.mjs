import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

function scriptRoot(scriptUrl) {
  if (!scriptUrl) return null;
  return dirname(dirname(fileURLToPath(scriptUrl)));
}

function hasMarker(root, relativePath) {
  return Boolean(root) && existsSync(join(root, relativePath));
}

export function resolvePluginRoot({
  env = process.env,
  cwd = process.cwd(),
  scriptUrl,
  marker = '.codex-plugin/plugin.json',
} = {}) {
  const fromScript = scriptRoot(scriptUrl);
  if (hasMarker(fromScript, marker)) {
    return fromScript;
  }

  for (const key of ['PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT']) {
    const candidate = env[key];
    if (hasMarker(candidate, marker)) {
      return candidate;
    }
  }

  if (hasMarker(cwd, marker)) {
    return cwd;
  }

  return null;
}

export function resolveImplementationRoot(options = {}) {
  return resolvePluginRoot(options);
}
