/**
 * forge-client.mjs — Forge Session Tracker client (web trigger, OAuth 2.1
 * app-scoped tokens).
 *
 * POSTs `{ op, accessToken, args }` to the session-sync web trigger URL. The
 * server validates the access token against the Secret Store (no /myself, no
 * Jira API token). The token pair is a SECRET kept in the OS keychain
 * (lib/keychain.mjs); this client loads it lazily and, on a 401 (expired or
 * revoked access token), rotates it via `op:'refresh'` (server-side rotation +
 * reuse detection + family revocation), persists the new pair, and retries the
 * call once.
 *
 * Single-flight: concurrent calls during a refresh share ONE refresh request —
 * presenting the same refresh token twice would trip server-side reuse detection
 * and revoke the whole family. (Cross-process concurrency is an inherent
 * rotation hazard; if it ever trips, the user re-generates.)
 *
 * `fetch` / `loadTokens` / `saveTokens` are injectable so the refresh/retry
 * logic is unit-tested without the network or the real keychain.
 */
import { ResyncError } from './push.mjs';
import { loadTokens as defaultLoadTokens, saveTokens as defaultSaveTokens } from './keychain.mjs';

export class ForgeClient {
  /**
   * @param {object} opts
   * @param {string} opts.webtriggerUrl - Session-sync web trigger URL.
   * @param {function} [opts.fetch] - Injected fetch (tests); defaults to global.
   * @param {function} [opts.loadTokens] - Token loader; defaults to the keychain.
   * @param {function} [opts.saveTokens] - Token persister; defaults to the keychain.
   */
  constructor(opts = {}) {
    this.url = opts.webtriggerUrl;
    this._fetch = opts.fetch || globalThis.fetch;
    this.loadTokens = opts.loadTokens || defaultLoadTokens;
    this.saveTokens = opts.saveTokens || defaultSaveTokens;
    if (!this.url) {
      throw new Error(
        'ForgeClient: webtriggerUrl is required. Set JIRA_WEBTRIGGER_URL via /jira-setup ' +
        '(writes ~/.agentry-for-jira/config.json) or in settings.json env.'
      );
    }
    this._tokens = null; // cached { accessToken, refreshToken, accessExp }
    this._refreshInFlight = null; // single-flight refresh promise
  }

  async _getTokens() {
    if (!this._tokens) this._tokens = await this.loadTokens();
    return this._tokens;
  }

  /** Rotate the refresh token (single-flight). Persists the new pair before use. */
  _doRefresh() {
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = (async () => {
      const t = await this._getTokens();
      if (!t || !t.refreshToken) {
        throw new Error('No refresh token available — generate one and re-run /jira-setup.');
      }
      const body = await this._post({ op: 'refresh', refreshToken: t.refreshToken });
      const fresh = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        accessExp: body.accessExp,
      };
      // Persist FIRST: if we crash before saving, the old (now-consumed) refresh
      // is dead and the user must re-generate. Persisting shrinks that window.
      await this.saveTokens(fresh);
      this._tokens = fresh;
      return fresh;
    })().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  /** POST a body; throw an Error with `.status` + `.body` on non-2xx. */
  async _post(bodyObj) {
    const res = await this._fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || text || `HTTP ${res.status}`;
      const err = new Error(`Forge trigger error (${res.status}): ${msg}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /**
   * Invoke a web-trigger op with the access token. On 401, refresh + retry once.
   * @param {{op: string, args?: object}} input
   * @returns {Promise<object>} Parsed response body.
   */
  async callTrigger({ op, args = {} }) {
    const tokens = await this._getTokens();
    if (!tokens || !tokens.accessToken) {
      throw new Error(
        'No access token configured — generate one in the Jira "Agent Sessions" page ' +
        'and run /jira-setup, then retry.'
      );
    }
    try {
      return await this._post({ op, accessToken: tokens.accessToken, args });
    } catch (e) {
      if (e?.status !== 401) throw e;
      // Expired or revoked access token → rotate, persist, retry once.
      try {
        const fresh = await this._doRefresh();
        return await this._post({ op, accessToken: fresh.accessToken, args });
      } catch (refreshErr) {
        const err = new Error(
          'Access token invalid and refresh failed — re-generate the token in the ' +
          'Jira "Agent Sessions" page and re-run /jira-setup.'
        );
        err.code = 'REGENERATE';
        err.cause = refreshErr;
        throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Append a session (full OR incremental delta). Surfaces a 409 GAP
   * ({resync:true}) as a ResyncError so push.mjs can fall back to a full push.
   */
  async appendSession(p) {
    const { sessionId, projectName, fromByte, tail, projectPath, isSessionEnd, agent } = p;
    const args = { sessionId, projectName, fromByte, tail };
    if (projectPath) args.projectPath = projectPath;
    if (isSessionEnd) args.isSessionEnd = isSessionEnd;
    if (agent) args.agent = agent;
    try {
      return await this.callTrigger({ op: 'append', args });
    } catch (e) {
      if (e?.status === 409 && e?.body?.resync === true) {
        throw new ResyncError({
          storedReplayLen: e.body.storedReplayLen,
          fromByte: e.body.fromByte ?? fromByte,
          message: e.body.message || e.message,
        });
      }
      throw e;
    }
  }

  /** List sessions. userId is NOT sent — the server scopes to the caller. */
  async listSessions(options = {}) {
    const args = {};
    if (options.projectName) args.projectName = options.projectName;
    if (options.limit) args.limit = options.limit;
    if (options.cursor) args.cursor = options.cursor;
    return this.callTrigger({ op: 'list', args });
  }

  async getSession(sessionId) {
    return this.callTrigger({ op: 'get', args: { sessionId } });
  }

  async getSessionRaw(sessionId) {
    return this.callTrigger({ op: 'get-raw', args: { sessionId } });
  }

  async getSessionReplay(sessionId) {
    return this.callTrigger({ op: 'restore', args: { sessionId } });
  }

  async deleteSession(sessionId) {
    return this.callTrigger({ op: 'delete', args: { sessionId } });
  }

  /** Validate the current token (connection test for /jira-setup). */
  async whoami() {
    return this.callTrigger({ op: 'whoami' });
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  async linkSession(sessionId, issueKey, options = {}) {
    return this.callTrigger({
      op: 'link',
      args: {
        sessionId,
        issueKey,
        context: options.context || 'manual',
        note: options.note || '',
      },
    });
  }

  async getIssueSessions(issueKey) {
    return this.callTrigger({ op: 'list-issue', args: { issueKey } });
  }

  async getSessionLinks(sessionId) {
    return this.callTrigger({ op: 'list-session-links', args: { sessionId } });
  }

  async unlinkSession(sessionId, linkId) {
    return this.callTrigger({ op: 'unlink', args: { sessionId, linkId } });
  }

  // -------------------------------------------------------------------------
  // User Settings Backup
  // -------------------------------------------------------------------------

  /**
   * 备份用户 settings.json 到 Forge Session Tracker。
   * 客户端已在本地完成脱敏和 sha256 校验和计算，服务端注入属主信息。
   *
   * @param {object} args
   * @param {string} args.content - 已脱敏的 settings.json JSON 字符串
   * @param {string} args.checksum - sha256(content) hex
   * @param {string} args.scope - 作用域，通常为 'user'
   * @param {string} args.schemaVersion - 版本字符串，如 '1'
   * @param {string} args.agent - 客户端标识，如 'claude'
   * @returns {Promise<{ ownerAccountId, revision, sizeBytes?, backedUpAt, unchanged? }>}
   */
  async backupUserSettings(args) {
    return this.callTrigger({ op: 'backup-settings', args });
  }

  /**
   * 获取已备份的 settings.json。服务端从 token 注入属主。
   *
   * @param {string} [clientId] 选择来源终端；缺省时服务端退回 accountId（legacy）。
   * @returns {Promise<{ ownerAccountId, clientId, revision, backedUpAt, scope, content }>}
   */
  async getUserSettings(clientId) {
    const args = clientId ? { clientId } : {};
    return this.callTrigger({ op: 'get-settings', args });
  }

  // -------------------------------------------------------------------------
  // Clients (AI Terminals)
  // -------------------------------------------------------------------------

  /**
   * 幂等注册/刷新当前 AI 终端。clientId + 元数据由客户端确定性派生，
   * 服务端注入属主（accountId/email）。
   *
   * @param {object} args - { clientId, clientType, osType, osUsername, hostname?,
   *                          displayName?, ipAddress?, osVersion?, arch?, clientVersion? }
   * @returns {Promise<{ clientId, created, firstSeenAt, lastSeenAt, cloneSuspect }>}
   */
  async registerClient(args) {
    return this.callTrigger({ op: 'register-client', args });
  }

  /**
   * 列出当前用户的终端。
   * @returns {Promise<{ clients: Array }>}
   */
  async listClients() {
    return this.callTrigger({ op: 'list-clients', args: {} });
  }

  /** 获取单个终端详情（服务端做属主校验）。 */
  async getClient(clientId) {
    return this.callTrigger({ op: 'get-client', args: { clientId } });
  }

  // -------------------------------------------------------------------------
  // Claude Config Backup (~/.claude.json — global state / account / user MCP)
  // -------------------------------------------------------------------------

  /**
   * 备份用户 ~/.claude.json（精简+脱敏后）到 Forge Session Tracker。
   * 客户端已在本地完成精简（slimClaudeJson）、脱敏（redactSecrets）和 sha256
   * 校验和计算，服务端注入属主信息。
   *
   * @param {object} args
   * @param {string} args.content - 已精简+脱敏的 .claude.json JSON 字符串
   * @param {string} args.checksum - sha256(content) hex
   * @param {string} args.scope - 作用域，通常为 'user'
   * @param {string} args.schemaVersion - 版本字符串，如 '1'
   * @param {string} args.agent - 客户端标识，如 'claude'
   * @returns {Promise<{ ownerAccountId, revision, sizeBytes?, backedUpAt, unchanged? }>}
   */
  async backupClaudeConfig(args) {
    return this.callTrigger({ op: 'backup-claude-config', args });
  }

  /**
   * 获取已备份的 .claude.json（精简+脱敏后）。服务端从 token 注入属主。
   *
   * @param {string} [clientId] 选择来源终端；缺省时服务端退回 accountId（legacy）。
   * @returns {Promise<{ ownerAccountId, clientId, revision, backedUpAt, scope, content }>}
   */
  async getClaudeConfig(clientId) {
    const args = clientId ? { clientId } : {};
    return this.callTrigger({ op: 'get-claude-config', args });
  }

  // -------------------------------------------------------------------------
  // Resource Files Backup (~/.claude custom assets bundle)
  // -------------------------------------------------------------------------

  /**
   * 备份用户 ~/.claude 自定义资产（CLAUDE.md / rules / agents / commands / skills /
   * output-styles / keybindings + 树内引用脚本）到 Forge Session Tracker。
   * 客户端已在本地完成采集、脱敏（redactSecrets / scanTextSecrets）、打包与 sha256
   * 校验和计算，服务端注入属主信息。
   *
   * @param {object} args
   * @param {string} args.content - 完整 bundle JSON 字符串（含各文件内容）
   * @param {string} args.manifest - content-free 清单 JSON 字符串（供查看页）
   * @param {number} args.fileCount - bundle 中文件数
   * @param {string} args.checksum - 去重 checksum（基于文件 relPath + 各文件 checksum）
   * @param {string} args.scope - 作用域，通常为 'user'
   * @param {string} args.schemaVersion - 版本字符串，如 '1'
   * @param {string} args.agent - 客户端标识，如 'claude'
   * @param {string} args.clientId - 归属终端 id
   * @returns {Promise<{ ownerAccountId, clientId, revision, fileCount?, sizeBytes?, backedUpAt, unchanged? }>}
   */
  async backupResources(args) {
    return this.callTrigger({ op: 'backup-resources', args });
  }

  // -------------------------------------------------------------------------
  // Memory Backup (~/.claude 记忆文件 bundle：用户记忆 + 项目/Agent 自动记忆)
  // -------------------------------------------------------------------------

  /**
   * 备份用户记忆（~/.claude/CLAUDE.md）、项目自动记忆（projects/<proj>/memory/）与
   * Agent 自动记忆（agent-memory/<agentType>/）到 Forge Session Tracker。客户端已在
   * 本地完成采集、脱敏、打包与 sha256 校验和计算，服务端注入属主信息。
   *
   * @param {object} args
   * @param {string} args.content - 完整 bundle JSON 字符串（含各文件内容 + group 分组键）
   * @param {string} args.manifest - content-free 清单 JSON 字符串（供查看页；含 byCategory/byGroup）
   * @param {number} args.fileCount - bundle 中文件数
   * @param {string} args.checksum - 去重 checksum（基于文件 relPath + 各文件 checksum）
   * @param {string} args.scope - 作用域，通常为 'user'
   * @param {string} args.schemaVersion - 版本字符串，如 '1'
   * @param {string} args.agent - 客户端标识，如 'claude'
   * @param {string} args.clientId - 归属终端 id
   * @returns {Promise<{ ownerAccountId, clientId, revision, fileCount?, sizeBytes?, backedUpAt, unchanged? }>}
   */
  async backupMemory(args) {
    return this.callTrigger({ op: 'backup-memory', args });
  }

  /**
   * 获取已备份的记忆 bundle。服务端从 token 注入属主。
   *
   * @param {string} [clientId] 选择来源终端；缺省时服务端退回 accountId（legacy）。
   * @returns {Promise<{ ownerAccountId, clientId, revision, backedUpAt, scope, content }>}
   */
  async getMemory(clientId) {
    const args = clientId ? { clientId } : {};
    return this.callTrigger({ op: 'get-memory', args });
  }

  // -------------------------------------------------------------------------
  // Plugins Backup (~/.claude/plugins 清单：installed_plugins + known_marketplaces)
  // -------------------------------------------------------------------------

  /**
   * 备份插件清单 + 市场源到 Forge Session Tracker。客户端已完成规范化 + checksum，
   * 服务端注入属主。
   *
   * @param {object} args - { content, checksum, pluginCount, marketplaceCount,
   *                          scope, schemaVersion, agent, clientId }
   * @returns {Promise<{ ownerAccountId, clientId, revision, sizeBytes?, backedUpAt, unchanged? }>}
   */
  async backupPlugins(args) {
    return this.callTrigger({ op: 'backup-plugins', args });
  }

  /**
   * 获取已备份的插件/市场 bundle。服务端从 token 注入属主。
   * @param {string} [clientId] 选择来源终端；缺省时服务端退回 accountId（legacy）。
   */
  async getPlugins(clientId) {
    const args = clientId ? { clientId } : {};
    return this.callTrigger({ op: 'get-plugins', args });
  }

  // -------------------------------------------------------------------------
  // Codex Config Backup (~/.codex/config.toml — model/provider/MCP/projects)
  // -------------------------------------------------------------------------

  /**
   * 备份用户 ~/.codex/config.toml（脱敏后）到 Forge Session Tracker。
   * 客户端已在本地完成脱敏（redactTomlSecrets：[mcp_servers.*.env] 内密钥名赋值
   * 替换为 <REDACTED>）和 sha256 校验和计算，服务端注入属主信息。
   *
   * @param {object} args
   * @param {string} args.content - 已脱敏的 config.toml 文本
   * @param {string} args.checksum - sha256(content) hex
   * @param {string} args.scope - 作用域，通常为 'user'
   * @param {string} args.schemaVersion - 版本字符串，如 '1'
   * @param {string} args.agent - 客户端标识，如 'codex'
   * @returns {Promise<{ ownerAccountId, revision, sizeBytes?, backedUpAt, unchanged? }>}
   */
  async backupCodexConfig(args) {
    return this.callTrigger({ op: 'backup-codex-config', args });
  }

  // -------------------------------------------------------------------------
  // Unified Codex Backup (APDEVIMP-83 — config + assets + memory, per-category)
  // -------------------------------------------------------------------------

  /**
   * 统一上传 Codex 的全部类别（config / agents / skills / rules / hooks /
   * guidance / local-memory）到 Forge Session Tracker。一次请求携带多类，服务端
   * 逐类 upsert 到各自 blob（每类独立 checksum，未变短路）。客户端已完成本地脱敏。
   *
   * @param {object} args
   * @param {string} args.clientId - 本 Codex 终端 id
   * @param {string} args.agent - 客户端标识，通常 'codex'
   * @param {Array<object>} args.categories - 各类载荷（single: {category,kind,checksum,content}；
   *   multi: {category,kind,checksum,bundle,manifest,fileCount}）
   * @returns {Promise<{ ownerAccountId, clientId, results: Record<string, object> }>}
   */
  async backupCodex(args) {
    return this.callTrigger({ op: 'backup-codex', args });
  }
}
