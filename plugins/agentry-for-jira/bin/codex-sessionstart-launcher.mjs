#!/usr/bin/env node

import { spawn } from 'child_process';
import { join } from 'path';
import { resolvePluginRoot } from '../lib/plugin-root.mjs';
const pluginRoot = resolvePluginRoot({ scriptUrl: import.meta.url });
if (!pluginRoot) {
  process.stderr.write(
    'agentry-for-jira hook: could not resolve plugin root for SessionStart launcher.\n'
  );
  // SessionStart tolerates silent no-output on failure (unlike Stop, it has no
  // JSON stdout contract to satisfy) — just skip the nudge for this session.
  process.exit(0);
}

const entry = join(pluginRoot, 'lib', 'codex-check-config-hook.mjs');
const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(`agentry-for-jira hook: failed to launch SessionStart check-config hook: ${err.message}\n`);
  process.exit(0);
});
