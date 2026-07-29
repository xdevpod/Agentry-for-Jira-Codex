#!/usr/bin/env node

import { spawn } from 'child_process';
import { join } from 'path';
import { resolvePluginRoot } from '../lib/plugin-root.mjs';
const pluginRoot = resolvePluginRoot({ scriptUrl: import.meta.url });
if (!pluginRoot) {
  process.stderr.write(
    'agentry-for-jira: could not resolve plugin root for Codex MCP launcher.\n'
  );
  process.exit(1);
}

const entry = join(pluginRoot, 'mcp-server', 'index.mjs');
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
  process.stderr.write(`agentry-for-jira: failed to launch MCP server: ${err.message}\n`);
  process.exit(1);
});
