// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic ↔ MCP Tools 转换
// ═══════════════════════════════════════════════

const crypto = require('crypto');

function _envFlag(name) {
  return /^(1|true|yes)$/i.test(process.env[name] || '');
}

function normalizeClientToolNameForPolicy(name) {
  return String(name || '')
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^mcp_/, '')
    .replace(/[-_\s.]/g, '')
    .toLowerCase();
}

const MCP_WIRE_ALIAS_TOOL_NAMES = new Set([
  'AskQuestion', 'Delete', 'Edit', 'EditNotebook', 'FetchMcpResource',
  'GenerateImage', 'Glob', 'Grep', 'ListMcpResources', 'Read',
  'ReadLints', 'Shell', 'StrReplace', 'SwitchMode', 'Task',
  'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
]);

function normalizeMcpWireToolNameForClient(name, registeredNames) {
  const raw = String(name || '');
  if (raw.startsWith('mcp_') && !raw.startsWith('mcp__')) {
    const unprefixed = raw.slice(4);
    if (!registeredNames || registeredNames.has(unprefixed) || MCP_WIRE_ALIAS_TOOL_NAMES.has(unprefixed)) {
      return unprefixed;
    }
  }
  return raw;
}

const CLIENT_WEB_SEARCH_TOOL_NAMES = new Set([
  'websearch',
  'websearchtool',
  'search',
]);

const CLIENT_WEB_FETCH_TOOL_NAMES = new Set([
  'webfetch',
  'fetch',
  'webfetchtool',
  'browserfetch',
]);

function isClientWebSearchToolName(name) {
  return CLIENT_WEB_SEARCH_TOOL_NAMES.has(normalizeClientToolNameForPolicy(name));
}

function isClientWebFetchToolName(name) {
  return CLIENT_WEB_FETCH_TOOL_NAMES.has(normalizeClientToolNameForPolicy(name));
}

function isClientWebLookupToolName(name) {
  return isClientWebSearchToolName(name) || isClientWebFetchToolName(name);
}

function shouldDropClientWebLookupToolName(name) {
  if (isClientWebSearchToolName(name)) {
    return !(_envFlag('CURSOR_ALLOW_CLIENT_WEB_TOOLS') || _envFlag('CURSOR_ALLOW_CLIENT_WEBSEARCH'));
  }
  if (isClientWebFetchToolName(name)) {
    return !(
      _envFlag('CURSOR_ALLOW_CLIENT_WEB_TOOLS') ||
      _envFlag('CURSOR_ALLOW_CLIENT_WEBFETCH') ||
      process.env.CURSOR_SERVER_WEBFETCH !== '0'
    );
  }
  return false;
}

/**
 * Anthropic tool definitions → intermediate MCP tool descriptors.
 *
 * Returns plain objects with the raw JSON schema; cursor-agent.js converts
 * them into protobuf McpToolDefinition messages (encoding the schema as a
 * google.protobuf.Value binary blob).
 */
// Strip per-property descriptions out of a JSON schema (in place on a clone).
// Many Anthropic tools embed verbose LLM-targeted hints under
// properties[].description that duplicate the top-level tool description,
// adding kilobytes per tool. Cursor's upstream provider rejects requests
// with too-large tool schemas (ERROR_PROVIDER_ERROR / resource_exhausted).
function _stripSchemaDescriptions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  // shallow clone is fine — we don't mutate child references except by
  // replacement
  const cloned = Array.isArray(schema) ? schema.slice() : { ...schema };
  if (cloned.description) delete cloned.description;
  if (cloned.properties && typeof cloned.properties === 'object') {
    const newProps = {};
    for (const k of Object.keys(cloned.properties)) {
      newProps[k] = _stripSchemaDescriptions(cloned.properties[k]);
    }
    cloned.properties = newProps;
  }
  if (cloned.items) cloned.items = _stripSchemaDescriptions(cloned.items);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(cloned[key])) {
      cloned[key] = cloned[key].map(_stripSchemaDescriptions);
    }
  }
  return cloned;
}

function anthropicToolsToMcpTools(tools, providerIdentifier) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return [];

  const provider = providerIdentifier || 'cursoride2api';
  // Keep broad web search native to Cursor by default. Forwarding client
  // WebSearch/Search tools creates MCP aliases that compete with Cursor's
  // native web-search path and encourages local fallback behavior.
  tools = tools.filter(t => !(t && shouldDropClientWebLookupToolName(t.name)));

  // Cursor's upstream provider rejects requests with too many tools
  // (empirical threshold ~10-12 tools regardless of trimming). Two knobs:
  //
  //   TOOL_INCLUDE = comma-separated allowlist of tool names. If set, only
  //   tools whose names match are forwarded. Use this to pick a workable
  //   subset for clients with large tool sets (Claude Code ships 49 tools
  //   alphabetically including CronCreate, Skill, Monitor, etc. that crowd
  //   out the core editing tools).
  //
  //   TOOL_LIMIT = max tool count after applying TOOL_INCLUDE. Default 0
  //   (unlimited). Useful as a hard cap when the client's allowlist is
  //   still too large.
  //
  // Example: TOOL_INCLUDE="Read,Write,Edit,Bash,Glob,Grep,WebFetch" keeps
  // just the file/shell/search core, well within Cursor's tool budget.
  const includeEnv = (process.env.TOOL_INCLUDE || '').trim();
  if (includeEnv) {
    const allow = new Set(includeEnv.split(/[,\s]+/).map(s => s.trim()).filter(Boolean));
    tools = tools.filter(t => t && t.name && allow.has(t.name));
  }
  const limitEnv = process.env.TOOL_LIMIT;
  const toolLimit = limitEnv == null || limitEnv === '' ? 0 : parseInt(limitEnv, 10);
  if (toolLimit > 0 && tools.length > toolLimit) {
    tools = tools.slice(0, toolLimit);
  }
  // Description trimming. TOOL_DESC_LIMIT defaults to 600 chars — Cursor's
  // upstream provider rejects payloads with too-large aggregate tool schema,
  // and Claude Code's stock tool set has 4-10KB descriptions per tool.
  // Set TOOL_DESC_LIMIT=0 to disable trimming.
  const envLimit = process.env.TOOL_DESC_LIMIT;
  const descLimit = envLimit === '' || envLimit == null ? 600 : parseInt(envLimit, 10);
  // Schema trimming: when total tool-schema bytes exceed this threshold (default
  // 30KB), strip per-property descriptions to shrink the payload further.
  // Set TOOL_SCHEMA_TRIM_BYTES=0 to disable.
  const schemaTrimEnv = process.env.TOOL_SCHEMA_TRIM_BYTES;
  const schemaTrimBytes = schemaTrimEnv === '' || schemaTrimEnv == null ? 30000 : parseInt(schemaTrimEnv, 10);

  // First pass — measure approximate combined schema size (to decide whether
  // to strip property descriptions).
  let approxSchemaBytes = 0;
  for (const tool of tools) {
    if (!tool || !tool.name) continue;
    if (tool.input_schema) {
      try { approxSchemaBytes += JSON.stringify(tool.input_schema).length; } catch { /* ignore */ }
    }
  }
  const stripPropDescs = schemaTrimBytes > 0 && approxSchemaBytes > schemaTrimBytes;

  const out = [];
  for (const tool of tools) {
    if (!tool || !tool.name) continue;

    let schema = tool.input_schema || { type: 'object', properties: {}, required: [] };
    if (stripPropDescs) schema = _stripSchemaDescriptions(schema);

    let description = tool.description || '';
    if (descLimit > 0 && description.length > descLimit) {
      description = description.slice(0, descLimit) + '...';
    }

    out.push({
      name: tool.name,
      toolName: tool.name,
      description,
      providerIdentifier: provider,
      jsonSchema: schema,
    });
  }

  return out;
}

/**
 * 生成可逆的 tool_use_id
 * 把 conversationKey/execId/toolCallId/sessionId 打包成 base64url，便于后续解析
 * 格式: toolu_<base64url(JSON)>
 *
 * `sessionId` (optional, encoded as `si`) is a per-bridge UUID minted by the
 * proxy. Continuations carrying any tool_use_id let us look up the original
 * bridge by sessionId, which is stable even when the client reconnects on a
 * fresh TCP socket (undici's 4 s keepAliveTimeout closes idle conns; the
 * follow-up request lands on a new remotePort and would otherwise miss the
 * bridge cache). sessionId is a uuid → unique across concurrent sessions even
 * when their salted bridgeKey would have collided.
 */
function encodeToolUseId(conversationKey, execId, toolCallId, sessionId) {
  const obj = {
    ck: String(conversationKey || ''),
    ei: String(execId || ''),
    tc: String(toolCallId || ''),
  };
  if (sessionId) obj.si = String(sessionId);
  const packed = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `toolu_${packed}`;
}

/**
 * 解析 tool_use_id → { conversationKey, execId, toolCallId, sessionId }
 * 解析失败返回 null
 *
 * `sessionId` is empty for tool_use_ids minted before this field existed,
 * so callers must treat it as optional and fall back to bridgeKey lookup.
 */
function decodeToolUseId(toolUseId) {
  if (!toolUseId || typeof toolUseId !== 'string') return null;
  if (!toolUseId.startsWith('toolu_')) return null;

  const packed = toolUseId.slice('toolu_'.length);
  if (!packed) return null;

  try {
    const json = Buffer.from(packed, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') return null;
    return {
      conversationKey: obj.ck || '',
      execId: obj.ei || '',
      toolCallId: obj.tc || '',
      sessionId: obj.si || '',
    };
  } catch (e) {
    return null;
  }
}

/**
 * Normalize tool_result.content into a list of MCP-compatible content items.
 * Preserves both text and image blocks. Returns an array of either:
 *   { kind: 'text', text: string }
 *   { kind: 'image', mediaType: string, data: Buffer }
 *
 * Anthropic tool_result.content can be:
 *   - a plain string                                    → one text item
 *   - [{type:'text',text:'...'}]                        → text items
 *   - [{type:'image',source:{type:'base64',media_type:'image/png',data:'<b64>'}}]
 *                                                       → image items (with bytes decoded)
 *   - mixed arrays of the two
 */
function normalizeToolResultContent(content) {
  const items = [];
  if (content == null) return items;
  if (typeof content === 'string') {
    if (content) items.push({ kind: 'text', text: content });
    return items;
  }
  if (!Array.isArray(content)) {
    try { items.push({ kind: 'text', text: JSON.stringify(content) }); } catch (e) {
      items.push({ kind: 'text', text: String(content) });
    }
    return items;
  }
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text) items.push({ kind: 'text', text: b.text });
      continue;
    }
    if (b.type === 'image' && b.source && b.source.type === 'base64') {
      const mediaType = b.source.media_type || 'image/png';
      let data;
      try { data = Buffer.from(b.source.data || '', 'base64'); }
      catch (e) { data = null; }
      if (data && data.length > 0) {
        items.push({ kind: 'image', mediaType, data });
      }
      continue;
    }
    // Future-proof: forward unknown block types as their JSON serialization
    try { items.push({ kind: 'text', text: JSON.stringify(b) }); } catch (e) { /* skip */ }
  }
  return items;
}

/**
 * Legacy text-only stringifier — kept for callers that don't yet handle
 * the structured content list.
 */
function stringifyToolResultContent(content) {
  return normalizeToolResultContent(content)
    .filter(it => it.kind === 'text')
    .map(it => it.text)
    .join('\n');
}

/**
 * 遍历 Anthropic message history，提取所有 tool_result block
 */
function extractToolResults(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  const out = [];

  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!block || block.type !== 'tool_result') continue;

      const toolUseId = block.tool_use_id || '';
      const decoded = decodeToolUseId(toolUseId) || {
        conversationKey: '',
        execId: '',
        toolCallId: '',
        sessionId: '',
      };

      out.push({
        toolUseId,
        conversationKey: decoded.conversationKey,
        execId: decoded.execId,
        toolCallId: decoded.toolCallId,
        sessionId: decoded.sessionId,
        // Legacy field — text-only flattening for callers that haven't
        // adopted `contentItems`.
        content: stringifyToolResultContent(block.content),
        // Structured items preserving image blocks. Use this in the
        // cursor-agent.sendToolResult path so screenshots and other
        // media survive the round-trip.
        contentItems: normalizeToolResultContent(block.content),
        isError: !!block.is_error,
      });
    }
  }

  return out;
}

/**
 * 取 Anthropic /v1/messages 请求里的 tools 字段
 */
function extractTools(payload) {
  if (!payload || !Array.isArray(payload.tools)) return [];
  return payload.tools;
}

/**
 * 返回最后一条 user 消息（没有则返回 null）
 */
function findLatestUserMessage(messages) {
  if (!messages || !Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return m;
  }
  return null;
}

/**
 * 提取首条 user 消息的纯文本内容
 * 数组内容会拼接所有 text block；没有则返回空串
 */
function extractFirstUserText(messages) {
  if (!messages || !Array.isArray(messages)) return '';

  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const texts = [];
      for (const block of c) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
      return texts.join('\n');
    }
    return '';
  }
  return '';
}

/**
 * Stable hash of the system field — used to make bridge/conv keys unique
 * across clients that happen to share the same first user message.
 *
 * Claude Code injects a per-request `x-anthropic-billing-header` block
 * containing a unique `cch=<hash>` per turn. We strip that block so the
 * fingerprint stays stable across continuations of the same conversation.
 */
function _stripVolatileSystemContent(text) {
  if (!text) return text;
  // The billing-header block looks like:
  //   "x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=<hash>;"
  // Skip it entirely — Claude Code's per-request hash defeats stable keying.
  if (text.startsWith('x-anthropic-billing-header')) return '';
  return text;
}

function _systemFingerprint(system) {
  if (!system) return '';
  if (typeof system === 'string') {
    return _stripVolatileSystemContent(system).slice(0, 1024);
  }
  if (!Array.isArray(system)) return '';
  return system
    .filter(b => b && typeof b.text === 'string')
    .map(b => _stripVolatileSystemContent(b.text))
    .filter(t => t.length > 0)
    .join('\n')
    .slice(0, 1024);
}

/**
 * Hash a tool list down to 8 hex chars by sorted tool names. Used as a salt
 * component so two clients with different tool sets (e.g. one with playwright
 * MCP, one without) get distinct cache keys even if their first user text
 * happens to match. Stable within one session — the tool list doesn't change
 * across continuations.
 */
function _toolListHash(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const names = tools
    .map(t => (t && typeof t.name === 'string') ? t.name : '')
    .filter(Boolean)
    .sort()
    .join(',');
  if (!names) return '';
  return crypto.createHash('sha256').update(names).digest('hex').slice(0, 8);
}

/**
 * Stable conversation hash — used as cache key for opaque conversation
 * checkpoint state.
 *
 * Salt components, all stable across continuations of one session but
 * varying across distinct sessions:
 *   - modelId         — different models use different blob hashes
 *   - system          — Claude Code injects per-client skill/env content
 *   - first user text — first 200 chars
 *   - remoteAddr      — distinguishes different machines
 *   - remotePort      — distinguishes different TCP connections from the
 *                       same machine (a claude-code process keeps a
 *                       single keep-alive socket; two concurrent
 *                       processes get distinct ports)
 *   - tool-list hash  — different tool sets diverge automatically
 *
 * Collision class the circumstantial-hash form has: two SEQUENTIAL or
 * PARALLEL conversations from the same claude-code process (same
 * keep-alive socket → same remotePort) with identical first 200 chars
 * of user text hash to the same convKey. Within the 30-min TTL this
 * causes activeBridges / bridgesBySessionId collisions — manifesting
 * as hangs or cross-conversation bleed when a parallel pair starts
 * simultaneously.
 *
 * Fix: prefer the `x-claude-code-session-id` header that claude-code
 * 2.1.x sends on every /v1/messages request. It's stable across
 * continuations within one conversation and distinct across separate
 * conversations even when prompts are identical (verified empirically,
 * see DEVLOG "Conversation key collision" entry). The circumstantial
 * form is preserved as the fallback for clients that don't send it.
 *
 * `conv-v2:` / `bridge-v2:` prefix on the new path means rollout-
 * during-traffic doesn't accidentally alias to old cached entries.
 */
function deriveConversationKey(messages, modelId, system, tools, remoteAddr, remotePort, clientSessionId) {
  if (clientSessionId) {
    // v2: salt with firstUserText + toolHash so a WebSearch / Task
    // subagent spawned within the same claude-code session (same
    // sessionId, different prompt, different tool set) gets a distinct
    // convKey. Without these, parent + subagent collide on the bridge
    // cache and the subagent's tool_use_id routes onto the wrong H2
    // stream — observed symptom is the subagent's tool returning empty
    // and the parent turn stalling. Cross-session collisions (the
    // original bug) are still defended by sessionId.
    const first = extractFirstUserText(messages).slice(0, 200);
    const toolHash = _toolListHash(tools);
    return crypto
      .createHash('sha256')
      .update('conv-v2:' + (modelId || '') + ':' + clientSessionId + ':' + first + ':' + toolHash)
      .digest('hex')
      .slice(0, 16);
  }
  const first = extractFirstUserText(messages).slice(0, 200);
  const sys = _systemFingerprint(system);
  const addr = remoteAddr || '';
  const port = (remotePort != null && remotePort !== '') ? String(remotePort) : '';
  const toolHash = _toolListHash(tools);
  return crypto
    .createHash('sha256')
    .update('conv:' + (modelId || '') + ':' + sys + ':' + first + ':' + addr + ':' + port + ':' + toolHash)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Stable bridge cache key — used to find the open H2 stream when a tool_result
 * continuation request lands. Same scheme as the conversation key (with a
 * different namespace prefix) — see deriveConversationKey for the rationale
 * behind the v2/fallback split.
 */
function deriveBridgeKey(modelId, messages, system, tools, remoteAddr, remotePort, clientSessionId) {
  if (clientSessionId) {
    const first = extractFirstUserText(messages).slice(0, 200);
    const toolHash = _toolListHash(tools);
    return crypto
      .createHash('sha256')
      .update('bridge-v2:' + (modelId || '') + ':' + clientSessionId + ':' + first + ':' + toolHash)
      .digest('hex')
      .slice(0, 16);
  }
  const first = extractFirstUserText(messages).slice(0, 200);
  const sys = _systemFingerprint(system);
  const addr = remoteAddr || '';
  const port = (remotePort != null && remotePort !== '') ? String(remotePort) : '';
  const toolHash = _toolListHash(tools);
  return crypto
    .createHash('sha256')
    .update('bridge:' + (modelId || '') + ':' + sys + ':' + first + ':' + addr + ':' + port + ':' + toolHash)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Pull claude-code's stable conversation UUID off the inbound request.
 * Preference order:
 *   1. `x-claude-code-session-id` header — cleanest, no parsing.
 *   2. `body.metadata.user_id` — claude-code encodes
 *      `{device_id, account_uuid, session_id}` as a JSON STRING here;
 *      we parse it as the documented fallback.
 *
 * Returns null when neither is present (non-claude-code callers fall
 * back to the circumstantial-hash path in deriveConversationKey).
 */
function extractClientSessionId(req) {
  if (!req) return null;
  try {
    const hdr = req.headers && (
      req.headers['x-claude-code-session-id']
      || req.headers['X-Claude-Code-Session-Id']
      || req.headers['anthropic-session-id']
      || req.headers['x-anthropic-session-id']
      || req.headers['x-session-id']
    );
    if (typeof hdr === 'string' && hdr.length > 0) return hdr;
  } catch { /* ignore */ }
  // Fallback: body.metadata.user_id. Some clients pass a JSON-encoded string;
  // others pass a plain object. Try both shapes.
  try {
    const body = req.body || req._parsedBody || null;
    if (body && body.metadata && body.metadata.user_id != null) {
      let meta = body.metadata.user_id;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { /* leave as string */ }
      }
      if (meta && typeof meta === 'object' && typeof meta.session_id === 'string' && meta.session_id) {
        return meta.session_id;
      }
      if (typeof meta === 'string' && meta) {
        return meta;
      }
    }
  } catch { /* ignore — body shape varied or absent */ }
  return null;
}

/**
 * 根据 convKey 派生确定性 UUID v4 形态
 */
function deterministicConversationId(convKey) {
  const hex = crypto
    .createHash('sha256')
    .update('cursor-conv-id:' + (convKey || ''))
    .digest('hex')
    .slice(0, 32);
  const y = (0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${y}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 最后一条 user 消息是否包含 tool_result block
 */
function hasToolResults(messages) {
  const last = findLatestUserMessage(messages);
  if (!last || !Array.isArray(last.content)) return false;
  return last.content.some(b => b && b.type === 'tool_result');
}

/**
 * Detect "hallucinated tool calls" — text content matching the patterns
 * `[Tool call: NAME]`, `[Tool call: NAME({...json...})]`,
 * `[Tool call] NAME`, or `[Tool call] NAME({...json...})` that the model
 * sometimes emits as a *text block* instead of a structured tool_use.
 * Cursor's model can fall out of "tool-use mode" (especially on long
 * contexts or when tool-name conflicts confuse it, e.g. the model wants
 * Cursor's native `AskQuestion` but we registered it as `mcp_AskUserQuestion`)
 * and describe the call in text. claude-code shows the bracketed string
 * verbatim and the conversation stalls because no tool was actually invoked.
 *
 * Returns an array of { name, args } for each match.
 *
 * Uses a brace-depth-counting parser for the JSON args so embedded `{}/`}`
 * chars don't confuse it (a naive regex would). Quoted strings inside the
 * JSON are tracked so braces inside strings don't perturb depth.
 *
 * Returns [] if no matches.
 */
function parseHallucinatedToolCalls(text) {
  const results = [];
  if (!text || typeof text !== 'string') return results;
  const TAGS = [
    { tag: '[Tool call: ', bracketAfterTag: false },
    { tag: '[Tool call] ', bracketAfterTag: true },
  ];
  let i = 0;
  while (i < text.length) {
    let match = null;
    for (const candidate of TAGS) {
      const idx = text.indexOf(candidate.tag, i);
      if (idx === -1) continue;
      if (!match || idx < match.start) {
        match = { ...candidate, start: idx };
      }
    }
    if (!match) break;

    const start = match.start;
    let p = start + match.tag.length;
    // Read tool name up to '(' or ']'.
    let nameEnd = p;
    while (nameEnd < text.length && text[nameEnd] !== '(' && text[nameEnd] !== ']') nameEnd++;
    const name = text.slice(p, nameEnd).trim();
    p = nameEnd;

    let args = {};
    let parseOk = true;
    if (text[p] === '(' && text[p + 1] === '{') {
      // Find the matching '}' for the JSON arg object using brace counting,
      // respecting string literals (so `"description":"})"` inside doesn't fool us).
      let depth = 0;
      let inStr = false;
      let escape = false;
      let jsonStart = p + 1;
      let jsonEnd = jsonStart;
      while (jsonEnd < text.length) {
        const c = text[jsonEnd];
        if (escape) { escape = false; jsonEnd++; continue; }
        if (c === '\\' && inStr) { escape = true; jsonEnd++; continue; }
        if (c === '"') { inStr = !inStr; jsonEnd++; continue; }
        if (!inStr) {
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) { jsonEnd++; break; } }
        }
        jsonEnd++;
      }
      if (depth !== 0) { parseOk = false; }
      else {
        const jsonStr = text.slice(jsonStart, jsonEnd);
        try { args = JSON.parse(jsonStr); }
        catch { parseOk = false; }
      }
      p = jsonEnd;
      if (text[p] === ')') p++;
    } else if (text[p] === ']') {
      // No args — keep args = {}.
    } else if (text[p] === '(' && text[p + 1] !== '{') {
      // Malformed — skip past the start tag and keep scanning.
      parseOk = false;
    }
    if (text[p] === ']') p++;
    else if (match.bracketAfterTag) {
      // `[Tool call] NAME({...})` closes its bracket before the name, so the
      // parsed span ends at the args close.
      p = Math.max(p, nameEnd);
    }

    if (parseOk && name) results.push({ name, args, span: [start, p] });
    // Always advance past the start tag at minimum to avoid infinite loop.
    i = Math.max(p, start + match.tag.length);
  }
  return results;
}

// Common Cursor-native → claude-code-tool-name mappings, used when a
// hallucinated tool call references a name we don't have but for which a
// claude-code equivalent exists. Preserves the model's intent without
// requiring an exact name match.
const HALLUCINATED_NAME_ALIASES = {
  'AskQuestion': 'AskUserQuestion',
  'Shell': 'Bash',
  'Ls': 'LS',
  'Fetch': 'WebFetch',
  'StrReplace': 'Edit',
};

function canonicalizeHallucinatedToolName(name, registeredNames) {
  if (!name) return name;
  if (registeredNames && registeredNames.has(name)) return name;
  const unprefixed = normalizeMcpWireToolNameForClient(name, registeredNames);
  if (unprefixed !== name) return unprefixed;
  const aliased = HALLUCINATED_NAME_ALIASES[name];
  if (aliased && registeredNames && registeredNames.has(aliased)) return aliased;
  // Caller decides whether to forward as-is and let claude-code report
  // "tool not found", or to drop. Default: forward as-is.
  return name;
}

// Field-name normalizers for known tools where the model reliably
// hallucinates a typo'd argument key. Applied AFTER the rescuer parses
// `[Tool call: NAME({...args})]` text and AFTER name canonicalization.
//
// Each normalizer mutates and returns the args object. It should be
// idempotent (running twice has the same effect as once) and only
// add fields when the canonical key is missing — never overwrite a
// correct value the model produced.
//
// Add new tools as new typo patterns surface. Don't try to be
// exhaustive; just cover what we observe in the wild.
const TOOL_ARG_NORMALIZERS = {
  Write(args) {
    if (!args || typeof args !== 'object') return args;
    // Hallucinated `contents` (plural) instead of `content` (singular)
    if (args.contents != null && args.content == null) {
      args.content = args.contents;
      delete args.contents;
    }
    // Some hallucinations use `body`/`text`/`data` for the file payload
    for (const alt of ['body', 'text', 'data', 'file_content']) {
      if (args[alt] != null && args.content == null) {
        args.content = args[alt];
        delete args[alt];
        break;
      }
    }
    // path → file_path
    if (args.path != null && args.file_path == null) {
      args.file_path = args.path;
      delete args.path;
    }
    return args;
  },
  Edit(args) {
    if (!args || typeof args !== 'object') return args;
    if (args.old != null && args.old_string == null) { args.old_string = args.old; delete args.old; }
    if (args.oldString != null && args.old_string == null) { args.old_string = args.oldString; delete args.oldString; }
    if (args.old_str != null && args.old_string == null) { args.old_string = args.old_str; delete args.old_str; }
    if (args.find != null && args.old_string == null) { args.old_string = args.find; delete args.find; }
    if (args.target != null && args.old_string == null) { args.old_string = args.target; delete args.target; }
    if (args.new != null && args.new_string == null) { args.new_string = args.new; delete args.new; }
    if (args.newString != null && args.new_string == null) { args.new_string = args.newString; delete args.newString; }
    if (args.new_str != null && args.new_string == null) { args.new_string = args.new_str; delete args.new_str; }
    if (args.replace != null && args.new_string == null) { args.new_string = args.replace; delete args.replace; }
    if (args.replacement != null && args.new_string == null) { args.new_string = args.replacement; delete args.replacement; }
    if (args.path != null && args.file_path == null) { args.file_path = args.path; delete args.path; }
    if (args.replaceAll != null && args.replace_all == null) { args.replace_all = args.replaceAll; delete args.replaceAll; }
    return args;
  },
  Grep(args) {
    if (!args || typeof args !== 'object') return args;
    if (args.outputMode != null && args.output_mode == null) { args.output_mode = args.outputMode; delete args.outputMode; }
    if (!args.output_mode) args.output_mode = 'files_with_matches';
    if (args.output_mode === 'files') args.output_mode = 'files_with_matches';
    return args;
  },
  MultiEdit(args) {
    if (!args || typeof args !== 'object') return args;
    if (args.path != null && args.file_path == null) { args.file_path = args.path; delete args.path; }
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) {
        if (!e || typeof e !== 'object') continue;
        if (e.old != null && e.old_string == null) { e.old_string = e.old; delete e.old; }
        if (e.new != null && e.new_string == null) { e.new_string = e.new; delete e.new; }
      }
    }
    return args;
  },
  Read(args) {
    if (!args || typeof args !== 'object') return args;
    if (args.path != null && args.file_path == null) { args.file_path = args.path; delete args.path; }
    return args;
  },
};

function normalizeHallucinatedToolArgs(toolName, args) {
  const fn = TOOL_ARG_NORMALIZERS[toolName];
  if (!fn) return args;
  try { return fn(args) || args; }
  catch { return args; }
}

module.exports = {
  anthropicToolsToMcpTools,
  normalizeClientToolNameForPolicy,
  normalizeMcpWireToolNameForClient,
  isClientWebSearchToolName, isClientWebFetchToolName,
  isClientWebLookupToolName, shouldDropClientWebLookupToolName,
  encodeToolUseId, decodeToolUseId,
  extractToolResults, extractTools,
  findLatestUserMessage, extractFirstUserText,
  deriveConversationKey, deriveBridgeKey,
  extractClientSessionId,
  deterministicConversationId,
  hasToolResults,
  parseHallucinatedToolCalls, canonicalizeHallucinatedToolName,
  normalizeHallucinatedToolArgs,
};
