/**
 * transcript-parser.mjs — Claude Code Session JSONL Parser (compat shim + CLI)
 *
 * Parsing and file-discovery logic now lives in lib/agents/claude.mjs. This
 * file re-exports it so existing imports (mcp-server, auto-push, tests) keep
 * working unchanged, and preserves the CLI entry point:
 *
 *   node transcript-parser.mjs [--session <id>] [--latest] [--dir <path>] [--json]
 *
 * The `--dir` flag is forwarded as { rootDir } to the discovery functions,
 * so CLI behavior is unchanged from before the move.
 */
import path from 'node:path';
import os from 'node:os';
import {
  parseSession,
  findSessionFile,
  findLatestSessionFile,
  findCurrentProjectSession,
  getRawJsonlContent,
  extractProjectName,
  formatTokenCount,
} from './agents/claude.mjs';

export {
  parseSession,
  findSessionFile,
  findLatestSessionFile,
  findCurrentProjectSession,
  getRawJsonlContent,
  extractProjectName,
};

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const ROOT_DIR = flag('--dir', path.join(os.homedir(), '.claude', 'projects'));
const SESSION_ID = flag('--session', null);
const LATEST = argv.includes('--latest');
const AS_JSON = argv.includes('--json');

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const opts = { rootDir: ROOT_DIR };
  let filePath;

  if (SESSION_ID) {
    filePath = findSessionFile(SESSION_ID, opts);
    if (!filePath) {
      console.error(`❌ Session not found: ${SESSION_ID}`);
      process.exit(1);
    }
  } else if (LATEST) {
    filePath = findLatestSessionFile(opts);
    if (!filePath) {
      console.error('❌ No session files found');
      process.exit(1);
    }
  } else {
    // Default: latest session for current project
    filePath = findCurrentProjectSession(opts) || findLatestSessionFile(opts);
    if (!filePath) {
      console.error('❌ No session files found');
      process.exit(1);
    }
  }

  const session = await parseSession(filePath);

  if (AS_JSON) {
    console.log(JSON.stringify(session, null, 2));
  } else {
    console.log(`\n📋 Session: ${session.sessionId}`);
    console.log(`   Project: ${session.projectName}`);
    console.log(`   Time:    ${session.startTime || '?'} ~ ${session.endTime || '?'}`);
    console.log(`   Duration: ${session.duration || 'unknown'}`);
    console.log(`   Tokens:  ${formatTokenCount(session.tokenUsage.total)} (in ${formatTokenCount(session.tokenUsage.input)}, out ${formatTokenCount(session.tokenUsage.output)})`);
    console.log(`\n💬 Messages: ${session.humanMessages.length} human, ${session.assistantMessages.length} assistant`);
    console.log(`📝 File changes: ${session.fileChanges.length}`);
    console.log(`🔧 Commands: ${session.commandsExecuted.length}`);
    if (session.skillsUsed.length) {
      console.log(`⚡ Skills: ${session.skillsUsed.join(', ')}`);
    }

    if (session.fileChanges.length > 0) {
      console.log('\n📝 File Changes:');
      for (const fc of session.fileChanges.slice(0, 20)) {
        console.log(`   ${fc.action}: ${fc.path}`);
      }
      if (session.fileChanges.length > 20) {
        console.log(`   ... and ${session.fileChanges.length - 20} more`);
      }
    }
  }
}

// Only run CLI when executed directly
if (process.argv[1] && process.argv[1].endsWith('transcript-parser.mjs')) {
  main().catch((err) => {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  });
}
