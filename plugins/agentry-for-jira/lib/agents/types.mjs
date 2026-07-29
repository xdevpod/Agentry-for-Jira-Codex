/**
 * types.mjs — Agent adapter interface (JSDoc only, no runtime code).
 *
 * An agent adapter encapsulates everything agent-specific about discovering
 * and reading/parsing a coding-agent's session transcript. The shared push
 * core (push.mjs, forge-client) is agent-agnostic: it only consumes the
 * RawSession contract from getRawJsonlContent. Two adapters (claude, codex)
 * implement this interface; lib/agents/index.mjs picks one via detectAgent().
 */

/**
 * Raw session content — the SOLE contract the push path consumes.
 * `content` is the original JSONL bytes (agent-agnostic); the server stores it
 * verbatim as the replay blob and parses it per-agent.
 *
 * @typedef {Object} RawSession
 * @property {string} content   Original JSONL file content (never transformed).
 * @property {string} filePath  Absolute path to the session file.
 * @property {string} sessionId Claude: filename; Codex: thread_id from first line.
 * @property {string} projectName Project namespace (cwd-encoded, shared shape).
 */

/**
 * Parsed session — adapters MUST output this same shape so upstream consumers
 * (MCP tools, future hooks) are agent-agnostic.
 *
 * @typedef {Object} ParsedSession
 * @property {string} sessionId
 * @property {string} projectName
 * @property {string|null} startTime
 * @property {string|null} endTime
 * @property {string|null} duration
 * @property {{timestamp:string, text:string}[]} humanMessages
 * @property {{timestamp:string, text:string, toolsUsed:string[]}[]} assistantMessages
 * @property {{action:string, path:string}[]} fileChanges
 * @property {{tool:string, command:string}[]} commandsExecuted
 * @property {{type:'tool_use'|'tool_result', [k:string]:any}[]} toolInteractions
 * @property {string[]} skillsUsed
 * @property {{input:number, output:number, cacheCreate:number, cacheRead:number, total:number}} tokenUsage
 * @property {{type:string, timestamp:string}} rawEntries
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} CLIENT_TYPE Terminal identity constant (feeds computeClientId).
 * @property {(env?: Record<string,string>) => string} detectClientVersion
 * @property {(sessionId:string, opts?:{rootDir?:string}) => (string|null)} findSessionFile
 * @property {(opts?:{rootDir?:string}) => (string|null)} findLatestSessionFile
 * @property {(opts?:{rootDir?:string, cwd?:string, envSessionId?:string}) => (string|null)} findCurrentProjectSession
 * @property {(options?:{filePath?:string, sessionId?:string, currentProject?:boolean, rootDir?:string}) => Promise<?RawSession>} getRawJsonlContent
 * @property {(filePath:string) => Promise<ParsedSession>} parseSession
 * @property {(filePath:string, opts?:{rootDir?:string}) => string} extractProjectName
 */

export {};
