// ═══════════════════════════════════════════════
//  CursorIDE2API - Cursor Agent Protocol Client
//  application/connect+proto (binary protobuf)
// ═══════════════════════════════════════════════
//
//  Like cursor-client.js, but keeps the H2 stream alive across tool calls.
//  Bubbles MCP tool calls up via onMcpCall, then resumes the stream when
//  the caller invokes sendToolResult(). Uses binary protobuf encoding so
//  Cursor's MCP tool dispatcher actually picks up tools registered via
//  RequestContext.tools.
//
//  Schemas live in src/proto/agent_pb.mjs (ESM); we load them at startup
//  via dynamic import. The first startConversation() call awaits the load;
//  subsequent calls are synchronous.

const http2 = require('http2');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const { generateChecksum } = require('./cursor-client');
const stallThresholds = require('./stall-thresholds');
const runtimeStats = require('./runtime-stats');

// Connect-protocol "end stream" frame flag
const CONNECT_END_STREAM_FLAG = 0b00000010;

// ── Lazy proto module loader ──
//
// `@bufbuild/protobuf` is dual-package; `agent_pb.mjs` is ESM only. From
// CommonJS we load both via `await import()` once and cache.
let _protoMod = null;
let _protoLoadPromise = null;

function loadProto() {
  if (_protoMod) return Promise.resolve(_protoMod);
  if (_protoLoadPromise) return _protoLoadPromise;
  _protoLoadPromise = (async () => {
    const protobuf = require('@bufbuild/protobuf');
    const wkt = require('@bufbuild/protobuf/wkt');
    const agent = await import('./proto/agent_pb.mjs');
    _protoMod = { ...protobuf, wkt, agent };
    return _protoMod;
  })();
  return _protoLoadPromise;
}

// Pre-warm so callers that need synchronous access (e.g. encodeValue) work.
loadProto().catch((e) => {
  console.error(`[cursor-agent] proto load failed: ${e.message}`);
});

// ── Frame helpers ──
//
// Connect protocol frame: [1-byte flags][4-byte BE length][payload]

function frameConnectMessage(payload, flags = 0) {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  if (payload.length > 0) Buffer.from(payload).copy(frame, 5);
  return frame;
}

// Legacy export — historical callers (anthropic-tools.js used to call this)
// passed plain JS objects. We keep the name and accept Uint8Array-or-Buffer.
function encodeFrame(payload) {
  if (Buffer.isBuffer(payload)) return frameConnectMessage(payload);
  if (payload instanceof Uint8Array) return frameConnectMessage(payload);
  // Legacy JSON-frame path — should not be reached after the proto migration
  // but keep it as a sentinel for backwards-compat with old callers.
  throw new Error('encodeFrame: connect+json frames are no longer supported; pass binary payload');
}

// ── Build H2 request headers ──
//
// The reverse-engineering doc (Cursor IDE API 逆向工程文档.md §2) lists the
// optional headers the IDE always sends. We were omitting them — `x-session-id`
// in particular looks like Cursor's signal for "this is a different agent
// window", and without it our proxy's concurrent claude-code sessions all
// look like one session to Cursor's backend. Match the IDE's shape: send a
// fresh UUID per Cursor stream as x-session-id, plus the other client-type
// hints. All overridable via env if a deployment needs to lie about its OS.
const _clientType = process.env.CURSOR_CLIENT_TYPE || 'ide';
const _clientOs = process.env.CURSOR_CLIENT_OS || (process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows_nt' : 'linux');
const _clientArch = process.env.CURSOR_CLIENT_ARCH || (process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch);
const _clientDevice = process.env.CURSOR_CLIENT_DEVICE_TYPE || 'desktop';
const _clientOsVersion = process.env.CURSOR_CLIENT_OS_VERSION || require('os').release();
const _clientCommit = process.env.CURSOR_COMMIT || 'd5c0e77a0214208f36b56d42e8e787de88d02ea4';
// Cache the timezone string at module load — Intl.DateTimeFormat() does
// non-trivial work and the answer never changes mid-process.
const _cursorTimezone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

function buildHeaders(token, sessionId) {
  return {
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    te: 'trailers',
    'authorization': `Bearer ${token.accessToken}`,
    'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
    'x-cursor-client-version': config.cursor.clientVersion,
    'x-cursor-timezone': _cursorTimezone,
    'x-request-id': uuidv4(),
    // Optional-but-IDE-always-sends headers. x-session-id is the load-bearing
    // one: it uniquely identifies a Cursor stream so the backend can schedule
    // concurrent sessions independently.
    'x-session-id': sessionId || uuidv4(),
    'x-ghost-mode': 'false',
    'x-cursor-client-type': _clientType,
    'x-cursor-client-os': _clientOs,
    'x-cursor-client-arch': _clientArch,
    'x-cursor-client-device-type': _clientDevice,
    // IDE-style fingerprint padding; harmless if backend ignores
    'x-cursor-client-os-version': _clientOsVersion,
    'x-cursor-commit': _clientCommit,
  };
}

// ═══════════════════════════════════════════════
//  Shared H2 client pool
// ═══════════════════════════════════════════════
//
// HTTP/2 multiplexes streams, so one TCP/TLS connection can serve many
// concurrent requests. But each connection has its own flow-control budget
// and one upstream scheduling context — which means a single shared client
// can produce unfair scheduling under load (a long tool-heavy turn can
// starve a simple no-tool question on the same connection).
//
// We keep a small pool of pre-warmed clients (default 3, override with
// H2_POOL_SIZE) and round-robin fresh streams across them. Continuations
// reuse the bridge they were originally bound to (so they stay on whichever
// client opened the original stream). Pre-warming hides the ~200-500ms
// TLS+H2 handshake from the first requests.
const _baseUrl = config.cursor.baseUrl;
const _poolSize = (() => {
  const raw = process.env.H2_POOL_SIZE;
  if (raw == null || raw === '') return 3;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();
const _pool = new Array(_poolSize).fill(null);
const _poolErrorCount = new Array(_poolSize).fill(0); // recent stream-error count per slot
const _poolLastUsedAt = new Array(_poolSize).fill(0); // ms timestamp of last getSharedClient hit
let _poolCursor = 0;

// Pool clients that have sat unused for this long get proactively recycled.
// Cursor's LB silently rotates connections under us — connections look "open"
// from Node's POV but the LB has already decided they're toast, so the first
// write returns REFUSED_STREAM (we don't see the GOAWAY event because the LB
// never sent us one cleanly). Recycling on idle prevents the cascade you see
// when the user opens a new claude-code session after a quiet period.
const POOL_MAX_IDLE_MS = (() => {
  const raw = process.env.CURSOR_POOL_MAX_IDLE_MS;
  if (raw == null || raw === '') return 5 * 60_000;  // 5 minutes default
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
})();

// Tag a client object with its pool slot so failOrRetry can find it without
// rescanning the pool. Set by _openClient; read by reportSlotError.
const _slotOf = new WeakMap();
// Mark clients that have received GOAWAY but haven't yet emitted 'close'.
// Node's http2 connection stays in a draining state during this window,
// and `c.closed` is still false — but new streams on it will get
// REFUSED_STREAM. We use this set to skip such clients in getSharedClient
// so a load-balancer cycle doesn't cascade across a fresh round of
// requests landing on draining connections.
const _drainingClients = new WeakSet();
// Per-client metadata for runtime-stats connection tracking. We record
// connection open/close events with lifetimes and stream counts so the
// stats endpoint can show how often Cursor's LB rotates connections, how
// many streams a typical client serves before churn, and which close
// reasons dominate (goaway / error / idle-recycle / poison).
const _clientMeta = new WeakMap();
function _markFirstClose(c, defaultReason) {
  const meta = _clientMeta.get(c);
  if (!meta || meta.closed) return;
  meta.closed = true;
  const reason = meta.closeReasonHint || defaultReason || 'unknown';
  try {
    runtimeStats.recordConnectionClose({
      slot: meta.slot,
      ageMs: Date.now() - meta.openedAt,
      streamsServed: meta.streamsServed,
      streamErrors: meta.streamErrors,
      closeReason: reason,
    });
  } catch { /* ignore */ }
}

function _openClient(slot) {
  if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] opening pool client #${slot} → ${_baseUrl}`);
  const c = http2.connect(_baseUrl, {
    settings: { initialWindowSize: 1024 * 1024 * 8 },
  });
  c.setMaxListeners(0);
  c.unref();
  _slotOf.set(c, slot);
  _clientMeta.set(c, {
    slot,
    openedAt: Date.now(),
    streamsServed: 0,
    streamErrors: 0,
    closed: false,
    closeReasonHint: null,
  });
  try { runtimeStats.recordConnectionOpen({ slot }); } catch { /* ignore */ }
  const drop = (why) => {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] pool client #${slot} ${why}`);
    if (_pool[slot] === c) _pool[slot] = null;
  };
  c.on('error', (e) => { _markFirstClose(c, 'error'); drop(`error: ${e.message}`); });
  c.on('close', () => { _markFirstClose(c, 'closed'); drop('closed'); });
  c.on('goaway', () => {
    // Mark draining BEFORE drop() nulls the slot — getSharedClient may be
    // called between goaway and close, and we don't want it to pick this
    // client even if the slot pointer hasn't been cleared yet (race).
    _drainingClients.add(c);
    _markFirstClose(c, 'goaway');
    drop('goaway');
  });
  _pool[slot] = c;
  _poolErrorCount[slot] = 0;          // fresh slot, reset error counter
  _poolLastUsedAt[slot] = Date.now(); // arm the idle-recycler timestamp
  return c;
}

// Background pool recycler. Runs every minute; closes any slot that hasn't
// served a getSharedClient() hit in POOL_MAX_IDLE_MS. The c.close() call
// triggers a GOAWAY → our existing handler nulls the slot and adds to
// _drainingClients. Active streams on the connection complete naturally.
const _poolRecycler = setInterval(() => {
  const now = Date.now();
  for (let i = 0; i < _poolSize; i++) {
    const c = _pool[i];
    if (!c || c.destroyed || c.closed) continue;
    if (_drainingClients.has(c)) continue;
    if (now - _poolLastUsedAt[i] > POOL_MAX_IDLE_MS) {
      if (process.env.CURSOR_AGENT_DEBUG) {
        const idleSec = Math.round((now - _poolLastUsedAt[i]) / 1000);
        console.log(`[cursor-agent][debug] pool slot #${i} idle ${idleSec}s; recycling`);
      }
      // Tag the close reason so the eventual c.on('close') records the
      // recycle origin instead of a generic 'closed'.
      const meta = _clientMeta.get(c);
      if (meta) meta.closeReasonHint = 'idle-recycle';
      try { c.close(); } catch { /* ignore */ }
      // Optimistically null the slot and mark draining so a fast-arriving
      // request opens a fresh client instead of racing the close event.
      _pool[i] = null;
      _drainingClients.add(c);
    }
  }
}, 60_000);
_poolRecycler.unref();

// Stream-level error happened on this client. Bump its slot's error count;
// if a slot crosses the threshold (3 errors in this session-lifetime),
// poison it so the next request opens a fresh connection.
const _SLOT_ERROR_THRESHOLD = 3;
function reportSlotError(client, reason) {
  if (!client) return;
  const slot = _slotOf.get(client);
  if (slot == null) return;
  // Bump per-client streamErrors regardless of pool replacement state —
  // the close event on this client will use it.
  const meta = _clientMeta.get(client);
  if (meta) meta.streamErrors++;
  if (_pool[slot] !== client) return; // already replaced
  _poolErrorCount[slot]++;
  if (_poolErrorCount[slot] >= _SLOT_ERROR_THRESHOLD) {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] pool slot #${slot} hit ${_poolErrorCount[slot]} errors (${reason}); evicting`);
    if (meta) meta.closeReasonHint = 'poison';
    _pool[slot] = null;
    _poolErrorCount[slot] = 0;
  }
}

// Get a client from the pool. Round-robins across all live slots; opens a
// fresh one in the chosen slot if it's empty (lazy refill on poison/close).
function getSharedClient() {
  for (let attempt = 0; attempt < _poolSize; attempt++) {
    const slot = _poolCursor % _poolSize;
    _poolCursor = (_poolCursor + 1) % _poolSize;
    const c = _pool[slot];
    // A "live" client must be: present, not destroyed, not closed, AND
    // not draining (received GOAWAY but not yet fully closed). The last
    // check catches the window where Cursor's LB just rotated us — new
    // streams on a draining client will get REFUSED_STREAM immediately.
    if (c && !c.destroyed && !c.closed && !_drainingClients.has(c)) {
      _poolLastUsedAt[slot] = Date.now();
      const meta = _clientMeta.get(c);
      if (meta) meta.streamsServed++;
      return c;
    }
    // Slot is empty/dead/draining — open fresh. If the old client was
    // draining, null it now so a future request doesn't get stuck on it.
    if (c) _pool[slot] = null;
    return _openClient(slot); // _openClient sets _poolLastUsedAt itself
  }
  // Should be unreachable — _poolSize >= 1.
  return _openClient(0);
}

// Mark a specific pool client as bad so the next request opens a fresh one
// in its slot. Called when a stream on `client` errors with REFUSED_STREAM
// (or similar). Other pool slots are untouched, so sibling sessions on
// healthy connections are unaffected.
//
// We deliberately do NOT call `client.close()` here. The bad client may
// still have other in-flight streams from sibling sessions; closing would
// send GOAWAY to Cursor and cascade-fail them. Just null the slot: future
// requests skip past it (or refill it), and the old client's streams
// complete on their own. GC reaps the orphan once they end.
function poisonSharedClient(reason, client) {
  for (let i = 0; i < _poolSize; i++) {
    if (_pool[i] === client) {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] poisoning pool slot #${i}: ${reason}`);
      _pool[i] = null;
      return;
    }
  }
  // Client wasn't in the pool (already replaced, or detached). Nothing to do.
  if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] poison called for unknown client: ${reason}`);
}

function prewarmSharedClient() {
  // Ensure proto is loaded too (it's lazy-loaded otherwise)
  loadProto().catch(() => { /* logged elsewhere */ });
  // Pre-warm every pool slot so the first N concurrent requests don't pay
  // the TLS+H2 handshake on the hot path.
  for (let i = 0; i < _poolSize; i++) {
    try { getSharedClient(); } catch (e) { /* swallow */ }
  }
}

// ── Deterministic conversation UUID derived from a key ──
function deterministicConversationId(convKey) {
  const hex = crypto.createHash('sha256')
    .update(`cursor-conv-id:${convKey}`)
    .digest('hex')
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

// ═══════════════════════════════════════════════
//  google.protobuf.Value codec (kept for legacy callers)
// ═══════════════════════════════════════════════
//
// `anthropic-tools.js` historically called `encodeValue` to base64-encode an
// inputSchema. After the proto migration, `anthropicToolsToMcpTools` returns
// the raw JSON schema and we encode in `buildMcpToolDefinitions` below.
//
// We still keep these exports for any external callers, mapping them to the
// new bufbuild Value codec. They throw if the proto module hasn't loaded
// (synchronous loadProto() can't await), which won't happen because
// loadProto() is kicked off at module load.

function _requireProto() {
  if (!_protoMod) {
    throw new Error('proto module not loaded yet — call await loadProto() first');
  }
  return _protoMod;
}

function encodeValue(json) {
  const { wkt, fromJson, toBinary } = _requireProto();
  const valueMsg = fromJson(wkt.ValueSchema, json == null ? null : json);
  return Buffer.from(toBinary(wkt.ValueSchema, valueMsg));
}

function decodeValueBytes(buf) {
  const { wkt, fromBinary, toJson } = _requireProto();
  const bytes = Buffer.isBuffer(buf) ? new Uint8Array(buf) : buf;
  const v = fromBinary(wkt.ValueSchema, bytes);
  return toJson(wkt.ValueSchema, v);
}

// ── Decode mcpArgs.args (Map<string, bytes>) into a plain JS object ──
function decodeMcpArgs(argsMap) {
  const out = {};
  if (!argsMap) return out;
  // Proto-decoded map is a plain object whose values are Uint8Array
  if (typeof argsMap !== 'object') return out;
  for (const k of Object.keys(argsMap)) {
    const v = argsMap[k];
    if (!v) { out[k] = null; continue; }
    let bytes;
    if (v instanceof Uint8Array) bytes = v;
    else if (Buffer.isBuffer(v)) bytes = new Uint8Array(v);
    else if (typeof v === 'string') {
      // Legacy connect+json path stored values as base64 strings
      try { bytes = new Uint8Array(Buffer.from(v, 'base64')); } catch { bytes = null; }
    } else {
      out[k] = v; // already a JS value
      continue;
    }
    if (!bytes) { out[k] = null; continue; }
    try {
      out[k] = decodeValueBytes(bytes);
    } catch {
      try { out[k] = Buffer.from(bytes).toString('utf8'); }
      catch { out[k] = null; }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════
//  Build McpToolDefinition list for RequestContext / runRequest
// ═══════════════════════════════════════════════
// Cursor's upstream Anthropic provider rejects requests with tool-name
// collisions between MCP tools (RequestContext.tools) and Cursor's built-in
// tool surface. The collision triggers ERROR_PROVIDER_ERROR /
// resource_exhausted before the model even runs.
//
// Two prefix strategies (set via MCP_PREFIX env):
//
//   safe-only (default) — only prefix tool names known to conflict with
//     Cursor's built-in surface. Tools whose names don't conflict
//     (`Bash`, `AskUserQuestion`, `Edit`, ...) are registered with their
//     natural names. The model recognizes these from its training and is
//     significantly more likely to call them via structured tool_use
//     instead of falling back to `[Tool call: ...]` text.
//
//   always — prefix every tool with `mcp_` (legacy behavior). Safe but
//     causes the model to see unfamiliar names, which contributes to the
//     hallucination of text-form tool calls. Use this if `safe-only`
//     produces ERROR_PROVIDER_ERROR for a tool we hadn't realized
//     conflicts.
const MCP_NAME_PREFIX = 'mcp_';
const MCP_PREFIX_MODE = (process.env.MCP_PREFIX || 'safe-only').toLowerCase().trim();
// Empirically blocked names from probing (DEVLOG); update if more
// collisions surface in the field. Anything in this set MUST be prefixed.
const CURSOR_NATIVE_TOOL_NAMES = new Set([
  'Read', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Shell', 'Delete', 'Task', 'TodoWrite', 'AskQuestion',
  'ListMcpResources', 'ReadLints', 'SwitchMode',
  // Belt-and-suspenders additions seen in Cursor's proto/UI:
  'Ls', 'Fetch', 'Diagnostics',
]);
function shouldPrefixToolName(name) {
  if (MCP_PREFIX_MODE === 'always') return true;
  // 'never' would skip every prefix; useful for debug experiments only.
  if (MCP_PREFIX_MODE === 'never') return false;
  // 'safe-only' (default): prefix only tools whose names conflict.
  return CURSOR_NATIVE_TOOL_NAMES.has(name);
}

// NOTE: an earlier attempt routed a tool-use nudge through
// `runRequest.customSystemPrompt`, but Cursor's upstream rejected those
// requests with `Connect error invalid_argument: unknown option
// '--system-prompt'` — the field appears account-gated or format-
// restricted in ways we can't safely probe. Removed. The selective
// `mcp_` prefix below + the hallucinated-tool-call rescuer in
// server.js are the working mitigations.

function buildMcpToolDefinitions(mcpToolsRaw) {
  if (!Array.isArray(mcpToolsRaw) || mcpToolsRaw.length === 0) return [];
  const { create, fromJson, toBinary, wkt, agent } = _requireProto();
  const out = [];
  for (const t of mcpToolsRaw) {
    if (!t || !t.name) continue;
    // Two shapes are accepted:
    //   { name, toolName, description, providerIdentifier, jsonSchema }
    //   { name, toolName, description, providerIdentifier, inputSchema } (raw bytes)
    let inputSchema;
    if (t.inputSchema && (t.inputSchema instanceof Uint8Array || Buffer.isBuffer(t.inputSchema))) {
      inputSchema = t.inputSchema instanceof Uint8Array ? t.inputSchema : new Uint8Array(t.inputSchema);
    } else {
      const schema = t.jsonSchema || t.input_schema || { type: 'object', properties: {}, required: [] };
      try {
        inputSchema = toBinary(wkt.ValueSchema, fromJson(wkt.ValueSchema, schema));
      } catch (e) {
        // Skip tools whose schema can't be encoded
        continue;
      }
    }
    // Decide wire name: prefix `mcp_` only when the name actually conflicts
    // with Cursor's built-in tool surface (in `safe-only` mode), or always
    // (legacy mode). Non-prefixed names match the model's training and
    // significantly reduce text-form tool-call hallucinations.
    // `toolName` is left unchanged so the dispatcher's mcpArgs.toolName
    // matches the original name on the way back.
    let wireName;
    if (t.name.startsWith(MCP_NAME_PREFIX)) {
      wireName = t.name; // already prefixed (e.g. mcp__playwright__*)
    } else if (shouldPrefixToolName(t.name)) {
      wireName = MCP_NAME_PREFIX + t.name;
    } else {
      wireName = t.name;
    }
    out.push(create(agent.McpToolDefinitionSchema, {
      name: wireName,
      toolName: t.toolName || t.name,
      description: t.description || '',
      providerIdentifier: t.providerIdentifier || 'cursoride2api',
      inputSchema,
    }));
  }
  return out;
}

// ═══════════════════════════════════════════════
//  ExecServerMessage handling
// ═══════════════════════════════════════════════

function handleExecMessage(execMsg, mcpToolDefs, sendBinaryFrame, onMcpCall) {
  const { create, toBinary, agent } = _requireProto();
  const A = agent;
  const id = execMsg.id;
  const execId = execMsg.execId || '';
  const msgCase = execMsg.message?.case;
  const msgValue = execMsg.message?.value;

  if (process.env.CURSOR_AGENT_DEBUG) {
    console.log(`[cursor-agent][debug] exec id=${id} execId=${execId} case=${msgCase}`);
  }

  // ── requestContextArgs → respond with our tools + env ──
  if (msgCase === 'requestContextArgs') {
    const requestContext = create(A.RequestContextSchema, {
      env: create(A.RequestContextEnvSchema, {
        osVersion: process.platform === 'win32' ? 'windows' : process.platform,
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
        workspacePaths: [],
      }),
      tools: mcpToolDefs,
      rules: [],
      repositoryInfo: [],
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    });
    const result = create(A.RequestContextResultSchema, {
      result: { case: 'success', value: create(A.RequestContextSuccessSchema, { requestContext }) },
    });
    sendExecClientMessage(id, execId, 'requestContextResult', result, sendBinaryFrame);
    return 'requestContext';
  }

  // ── mcpArgs → bubble up to caller ──
  if (msgCase === 'mcpArgs') {
    const m = msgValue || {};
    const args = decodeMcpArgs(m.args || {});
    const toolCallId = m.toolCallId || `tc_${Math.random().toString(36).slice(2)}`;
    const toolName = m.toolName || m.name || '';
    onMcpCall({ id, execId, toolCallId, toolName, args });
    return 'mcp';
  }

  const REJECT_REASON = 'Tool not available; use MCP tools.';

  // ── Reject native Cursor tools so the model falls back to MCP ──
  if (msgCase === 'readArgs') {
    const result = create(A.ReadResultSchema, {
      result: { case: 'rejected', value: create(A.ReadRejectedSchema, { path: msgValue?.path || '', reason: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'readResult', result, sendBinaryFrame);
    return 'read';
  }
  if (msgCase === 'lsArgs') {
    const result = create(A.LsResultSchema, {
      result: { case: 'rejected', value: create(A.LsRejectedSchema, { path: msgValue?.path || '', reason: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'lsResult', result, sendBinaryFrame);
    return 'ls';
  }
  if (msgCase === 'writeArgs') {
    const result = create(A.WriteResultSchema, {
      result: { case: 'rejected', value: create(A.WriteRejectedSchema, { path: msgValue?.path || '', reason: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'writeResult', result, sendBinaryFrame);
    return 'write';
  }
  if (msgCase === 'deleteArgs') {
    const result = create(A.DeleteResultSchema, {
      result: { case: 'rejected', value: create(A.DeleteRejectedSchema, { path: msgValue?.path || '', reason: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'deleteResult', result, sendBinaryFrame);
    return 'delete';
  }
  if (msgCase === 'shellArgs') {
    const result = create(A.ShellResultSchema, {
      result: {
        case: 'rejected',
        value: create(A.ShellRejectedSchema, {
          command: msgValue?.command || '',
          workingDirectory: msgValue?.workingDirectory || '',
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecClientMessage(id, execId, 'shellResult', result, sendBinaryFrame);
    return 'shell';
  }
  if (msgCase === 'shellStreamArgs') {
    // shellStreamArgs response type is `shellStream`, not `shellResult`.
    const result = create(A.ShellStreamSchema, {
      event: {
        case: 'rejected',
        value: create(A.ShellRejectedSchema, {
          command: msgValue?.command || '',
          workingDirectory: msgValue?.workingDirectory || '',
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecClientMessage(id, execId, 'shellStream', result, sendBinaryFrame);
    return 'shellStream';
  }
  if (msgCase === 'backgroundShellSpawnArgs') {
    const result = create(A.BackgroundShellSpawnResultSchema, {
      result: {
        case: 'rejected',
        value: create(A.ShellRejectedSchema, {
          command: msgValue?.command || '',
          workingDirectory: msgValue?.workingDirectory || '',
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecClientMessage(id, execId, 'backgroundShellSpawnResult', result, sendBinaryFrame);
    return 'backgroundShell';
  }
  if (msgCase === 'grepArgs') {
    const result = create(A.GrepResultSchema, {
      result: { case: 'error', value: create(A.GrepErrorSchema, { error: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'grepResult', result, sendBinaryFrame);
    return 'grep';
  }
  if (msgCase === 'fetchArgs') {
    const result = create(A.FetchResultSchema, {
      result: { case: 'error', value: create(A.FetchErrorSchema, { url: msgValue?.url || '', error: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'fetchResult', result, sendBinaryFrame);
    return 'fetch';
  }
  if (msgCase === 'writeShellStdinArgs') {
    const result = create(A.WriteShellStdinResultSchema, {
      result: { case: 'error', value: create(A.WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
    });
    sendExecClientMessage(id, execId, 'writeShellStdinResult', result, sendBinaryFrame);
    return 'writeShellStdin';
  }
  if (msgCase === 'diagnosticsArgs') {
    const result = create(A.DiagnosticsResultSchema, {
      result: { case: 'success', value: create(A.DiagnosticsSuccessSchema, { path: msgValue?.path || '', diagnostics: [], totalDiagnostics: 0 }) },
    });
    sendExecClientMessage(id, execId, 'diagnosticsResult', result, sendBinaryFrame);
    return 'diagnostics';
  }

  console.log(`[cursor-agent] unhandled exec case=${msgCase} execId=${execId}`);
  return 'unknown';
}

// Handle an InteractionQuery from Cursor by replying with an
// InteractionResponse that rejects the inner query. This is the path Cursor
// uses for native tools that aren't part of ExecServerMessage:
// WebSearch, WebFetch, ExaSearch, ExaFetch, AskQuestion, SwitchMode.
//
// Without a reply the model waits forever for our response and the whole
// turn hangs. Rejecting forces the model to fall back to the MCP-prefixed
// equivalent we registered (e.g. `mcp_WebSearch`), which we then bubble up
// to the client as a normal tool_use.
function handleInteractionQuery(iq, sendBinaryFrame) {
  const { create, toBinary, agent } = _requireProto();
  const A = agent;
  const id = iq.id;
  const queryCase = iq.query?.case;
  const REJECT_REASON = 'Tool not available; use MCP tools.';

  if (process.env.CURSOR_AGENT_DEBUG) {
    console.log(`[cursor-agent][debug] interactionQuery id=${id} case=${queryCase}`);
  }

  // Build the rejected `result` payload for each query type. The inner
  // shape varies — some have a flat oneof, others wrap it in a *Result.
  let resultCase, resultValue;
  switch (queryCase) {
    case 'webSearchRequestQuery':
      resultCase = 'webSearchRequestResponse';
      resultValue = create(A.WebSearchRequestResponseSchema, {
        result: { case: 'rejected', value: create(A.WebSearchRequestResponse_RejectedSchema, { reason: REJECT_REASON }) },
      });
      break;
    case 'webFetchRequestQuery':
      resultCase = 'webFetchRequestResponse';
      resultValue = create(A.WebFetchRequestResponseSchema, {
        result: { case: 'rejected', value: create(A.WebFetchRequestResponse_RejectedSchema, { reason: REJECT_REASON }) },
      });
      break;
    case 'exaSearchRequestQuery':
      resultCase = 'exaSearchRequestResponse';
      resultValue = create(A.ExaSearchRequestResponseSchema, {
        result: { case: 'rejected', value: create(A.ExaSearchRequestResponse_RejectedSchema, { reason: REJECT_REASON }) },
      });
      break;
    case 'exaFetchRequestQuery':
      resultCase = 'exaFetchRequestResponse';
      resultValue = create(A.ExaFetchRequestResponseSchema, {
        result: { case: 'rejected', value: create(A.ExaFetchRequestResponse_RejectedSchema, { reason: REJECT_REASON }) },
      });
      break;
    case 'switchModeRequestQuery':
      resultCase = 'switchModeRequestResponse';
      resultValue = create(A.SwitchModeRequestResponseSchema, {
        result: { case: 'rejected', value: create(A.SwitchModeRequestResponse_RejectedSchema, { reason: REJECT_REASON }) },
      });
      break;
    case 'askQuestionInteractionQuery':
      // AskQuestionInteractionResponse wraps an AskQuestionResult oneof.
      resultCase = 'askQuestionInteractionResponse';
      resultValue = create(A.AskQuestionInteractionResponseSchema, {
        result: create(A.AskQuestionResultSchema, {
          result: { case: 'rejected', value: create(A.AskQuestionRejectedSchema, { reason: REJECT_REASON }) },
        }),
      });
      break;
    default:
      // Unknown / not in our vendored proto (e.g. webFetchRequestQuery,
      // createPlanRequestQuery, setupVmEnvironmentArgs — proto field nums
      // 7-9 added in newer Cursor releases). Send a bare InteractionResponse
      // with just `id` set. Cursor's server treats an unset `result` oneof
      // as "client abandoned this request"; the model then falls back to
      // its MCP-prefixed equivalent (e.g. `mcp_WebFetch`) which we route
      // back to the client like any other tool_use.
      console.log(`[cursor-agent] interactionQuery case=${queryCase} id=${id} not handled in vendored proto; abandoning so model falls back to MCP`);
      resultCase = undefined;
      resultValue = undefined;
      break;
  }

  const interactionResponseFields = { id };
  if (resultCase) interactionResponseFields.result = { case: resultCase, value: resultValue };
  const interactionResponse = create(A.InteractionResponseSchema, interactionResponseFields);
  const wrapper = create(A.AgentClientMessageSchema, {
    message: { case: 'interactionResponse', value: interactionResponse },
  });
  sendBinaryFrame(toBinary(A.AgentClientMessageSchema, wrapper));
}

// ── Build an ExecClientMessage and send it as a binary connect frame ──
function sendExecClientMessage(id, execId, messageCase, value, sendBinaryFrame) {
  const { create, toBinary, agent } = _requireProto();
  const execClient = create(agent.ExecClientMessageSchema, {
    id, execId,
    message: { case: messageCase, value },
  });
  const wrapper = create(agent.AgentClientMessageSchema, {
    message: { case: 'execClientMessage', value: execClient },
  });
  sendBinaryFrame(toBinary(agent.AgentClientMessageSchema, wrapper));
}

// ── KV server message handling (blob store handshake) ──
function handleKvMessage(kvMsg, blobStore, sendBinaryFrame) {
  const { create, toBinary, agent } = _requireProto();
  const kvId = kvMsg.id;
  const kvCase = kvMsg.message?.case;
  const kvValue = kvMsg.message?.value || {};

  if (kvCase === 'setBlobArgs') {
    const blobId = kvValue.blobId;
    const blobData = kvValue.blobData || new Uint8Array(0);
    if (blobId && blobId.length > 0) {
      blobStore.set(Buffer.from(blobId).toString('hex'), blobData);
    }
    if (process.env.CURSOR_AGENT_DEBUG) {
      const idHex = blobId ? Buffer.from(blobId).toString('hex').slice(0, 24) : '';
      console.log(`[cursor-agent][debug] kv setBlob id=${kvId} blobId=${idHex}... bytes=${blobData?.length ?? 0}`);
    }
    sendKvResponse(kvId, 'setBlobResult', create(agent.SetBlobResultSchema, {}), sendBinaryFrame);
    return;
  }
  if (kvCase === 'getBlobArgs') {
    const blobId = kvValue.blobId;
    const idHex = blobId ? Buffer.from(blobId).toString('hex') : '';
    const blobData = blobStore.get(idHex);
    if (process.env.CURSOR_AGENT_DEBUG) {
      console.log(`[cursor-agent][debug] kv getBlob id=${kvId} blobId=${idHex.slice(0, 24)}... found=${blobData != null}`);
    }
    sendKvResponse(kvId, 'getBlobResult',
      create(agent.GetBlobResultSchema, blobData ? { blobData } : {}),
      sendBinaryFrame);
    return;
  }
  if (process.env.CURSOR_AGENT_DEBUG) {
    console.log(`[cursor-agent][debug] kv id=${kvId} unhandled case=${kvCase}`);
  }
}

function sendKvResponse(id, messageCase, value, sendBinaryFrame) {
  const { create, toBinary, agent } = _requireProto();
  const kvClient = create(agent.KvClientMessageSchema, {
    id,
    message: { case: messageCase, value },
  });
  const wrapper = create(agent.AgentClientMessageSchema, {
    message: { case: 'kvClientMessage', value: kvClient },
  });
  sendBinaryFrame(toBinary(agent.AgentClientMessageSchema, wrapper));
}

// ═══════════════════════════════════════════════
//  startConversation — Bridge object with persistent stream
// ═══════════════════════════════════════════════

function startConversation(token, options = {}) {
  const {
    prompt = '',
    modelId,
    conversationId = uuidv4(),
    conversationState = null,
    tools = [],
    // Per-bridge UUID, sent as x-session-id so Cursor's backend can
    // schedule concurrent claude-code sessions independently. Defaults to a
    // fresh uuid if the caller doesn't provide one.
    sessionId = uuidv4(),
    onTextDelta,
    onThinkingDelta,
    onMcpCall,
    onStepCompleted,
    onTurnEnded,
    onError,
  } = options;

  const currentCallbacks = {
    onTextDelta: onTextDelta || (() => {}),
    onThinkingDelta: onThinkingDelta || (() => {}),
    onMcpCall: onMcpCall || (() => {}),
    onStepCompleted: onStepCompleted || (() => {}),
    onTurnEnded: onTurnEnded || (() => {}),
    onError: onError || (() => {}),
  };

  function setCallbacks(newCallbacks) {
    if (!newCallbacks || typeof newCallbacks !== 'object') return;
    for (const k of ['onTextDelta', 'onThinkingDelta', 'onMcpCall', 'onStepCompleted', 'onTurnEnded', 'onError']) {
      if (typeof newCallbacks[k] === 'function') {
        currentCallbacks[k] = newCallbacks[k];
      }
    }
  }

  console.log(
    `[cursor-agent] new conv id=${conversationId} model=${modelId} ` +
    `hasState=${!!conversationState} tools=${(tools || []).length}`
  );

  // We need the proto module loaded before we can encode anything.
  // Most callers will already have it (we kicked off loadProto at import),
  // but if not, the bridge defers connection until the load completes.

  let client = null;
  let req = null;
  let closed = false;
  let connectionStarted = false;
  // Pending writes queued before loadProto resolves
  const pendingWrites = [];
  let buffer = Buffer.alloc(0);
  let inputTokens = 0;
  let outputTokens = 0;
  let capturedState = null;
  // Tracks whether Cursor sent us a turnEnded message. If req.on('end') fires
  // before this is set, the upstream cut us off mid-conversation and we need
  // to surface that as an error so the proxy's HTTP response gets a clean
  // 5xx (or stream error) instead of hanging forever.
  let turnEndedFired = false;
  // Blob store keyed by blobId hex string
  const blobStore = new Map();

  // ── Per-stream telemetry (for failure diagnostics) ──
  // We log a one-line `📊 stream-summary` on every stream error so we can
  // grep for patterns: do errors cluster on a specific pool slot? at a
  // certain age? after a certain byte count? after a certain tool count?
  // Numbers below are deliberately cheap to update — increments/timestamps
  // only — so they cost nothing on the hot path.
  let streamOpenedAt = 0;            // Date.now() at attemptConnection
  let streamBytesIn = 0;             // bytes received from req.on('data')
  let streamBytesOut = 0;            // bytes written via sendBinaryFrame
  let streamMcpCallCount = 0;        // count of mcpArgs received from Cursor
  let streamSummaryEmitted = false;  // dedupe — we may pass through multiple error paths
  // Last time we saw a *meaningful* frame from Cursor — text/thinking/tool/
  // step/checkpoint, NOT heartbeats. The watchdog uses this to detect a
  // stalled stream where Cursor keeps the H2 channel alive (heartbeats reset
  // req.setTimeout) but isn't actually advancing the turn. Without this we
  // saw 17-minute hangs after the model went silent post-thinking.
  let lastUsefulFrameAt = 0;
  // Largest gap between useful frames observed during the current attempt.
  // Recorded into the per-model rolling window on success so future turns
  // get adaptive thresholds. Reset on each retry attempt — only the
  // successful attempt's distribution should feed the threshold model.
  let maxIdleMs = 0;
  // Per-turn counters for runtime statistics. Reset at the start of each
  // new turn (initial bridge run + each sendToolResult continuation).
  // Reported via onTurnEnded / bridge.getStats() so server.js can feed
  // them to the runtime-stats aggregator.
  let _turnRetries = 0;
  let _turnTransportErrors = 0;
  let _turnStalls = 0;
  let _turnCascadeDetected = false;
  // Live in-flight diagnostics — exposed via bridge.getStats() so a
  // /stats/inflight endpoint can answer "is this turn thinking or stuck?"
  // in real time. textDelta/thinkingDelta counts rising = model is
  // actively producing; flat counts + idle bytesIn = upstream is silent
  // (heartbeats only). Reset at every new-turn boundary.
  let _turnTextDeltaCount = 0;
  let _turnThinkingDeltaCount = 0;
  let _bytesInAtLastUsefulFrame = 0;
  let watchdog = null;

  // Stall thresholds are per-model and adaptive — see src/stall-thresholds.js.
  // Each Cursor model variant has its own pre-content and post-content
  // threshold derived from a feature-based baseline (thinking? opus? max
  // effort?), upgraded to a p99-based threshold once we have enough
  // successful-turn samples for that model. Computed once per attempt
  // (cached in _stallPreMs / _stallPostMs) so the watchdog tick is cheap.
  let _stallPreMs = 0;
  let _stallPostMs = 0;
  let _stallSource = 'baseline';
  function _recomputeStallThresholds() {
    const t = stallThresholds.getThreshold(modelId);
    _stallPreMs = t.pre;
    _stallPostMs = t.post;
    _stallSource = t.source;
  }
  // Helper: mark a useful frame. Updates the maxIdleMs running max BEFORE
  // resetting the clock. Snapshots streamBytesIn so the live-diagnostics
  // endpoint can compute "bytes received since last useful frame" — if
  // that's stable while idle climbs, only heartbeats are flowing.
  function markUsefulFrame() {
    const now = Date.now();
    if (lastUsefulFrameAt > 0) {
      const idle = now - lastUsefulFrameAt;
      if (idle > maxIdleMs) maxIdleMs = idle;
    }
    lastUsefulFrameAt = now;
    _bytesInAtLastUsefulFrame = streamBytesIn;
  }
  function dumpStreamSummary(reason, code) {
    if (streamSummaryEmitted) return;
    streamSummaryEmitted = true;
    const ageMs = streamOpenedAt ? (Date.now() - streamOpenedAt) : -1;
    const slot = client ? _slotOf.get(client) : -1;
    // Single grep-able line. Keep it short.
    console.log(
      `  📊 stream-summary ` +
      `code=${code || 'none'} ` +
      `slot=${slot} ` +
      `ageMs=${ageMs} ` +
      `bytesIn=${streamBytesIn} ` +
      `bytesOut=${streamBytesOut} ` +
      `mcpCalls=${streamMcpCallCount} ` +
      `hasContent=${hasEmittedContent} ` +
      `retries=${retryAttempts} ` +
      `model=${modelId} ` +
      `sid=${(sessionId || '').slice(0, 8)} ` +
      `reason="${(reason || '').slice(0, 80)}"`
    );
  }

  function fail(msg) {
    if (closed) return;
    dumpStreamSummary(msg, 'fail');
    currentCallbacks.onError(msg);
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (watchdog) { try { clearInterval(watchdog); } catch { /* ignore */ } watchdog = null; }
    try { if (req) req.end(); } catch { /* ignore */ }
    setTimeout(() => {
      try { if (req) req.close(); } catch { /* ignore */ }
      // NOTE: do NOT close `client` — it's the shared H2 client serving
      // every request via stream multiplexing. Closing it would break
      // every other in-flight conversation.
    }, 200);
  }

  // Send a binary payload as a connect frame on the H2 stream.
  function sendBinaryFrame(payload) {
    if (closed) return;
    if (!req) {
      pendingWrites.push(payload);
      return;
    }
    try {
      const frame = frameConnectMessage(payload);
      req.write(frame);
      streamBytesOut += frame.length;
    } catch (e) {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] write failed: ${e.message}`);
    }
  }

  // Heartbeat — written as a binary connect frame
  let heartbeat = null;

  // sendToolResult: write mcpResult into the live stream
  //
  // `content` may be:
  //   - a string                                       → single text item
  //   - { error: 'msg' }                                → mcpResult.error
  //   - { items: [{kind:'text',text:''} | {kind:'image',mediaType:'',data:Buffer}, ...] }
  //                                                     → preserves multimodal
  //                                                       output (e.g., screenshots
  //                                                       returned by Read on a PNG).
  //   - any other value                                 → JSON-stringified text
  function sendToolResult(id, execId, content) {
    if (closed) return;
    // A new turn is starting — re-arm the stall watchdog. It was paused
    // when turnEndedFired flipped on at the previous turn's end; clearing
    // the flag and refreshing the timestamp gives the new turn a full
    // pre-content threshold to make progress before we trip. Also reset
    // maxIdleMs — only the new turn's gaps should feed the per-model stats.
    turnEndedFired = false;
    lastUsefulFrameAt = Date.now();
    maxIdleMs = 0;
    // Fresh turn — runtime-stats counters reset so this turn's outcome is
    // attributed only to its own retries / stalls / cascades.
    _turnRetries = 0;
    _turnTransportErrors = 0;
    _turnStalls = 0;
    _turnCascadeDetected = false;
    _turnTextDeltaCount = 0;
    _turnThinkingDeltaCount = 0;
    _bytesInAtLastUsefulFrame = streamBytesIn;
    const { create, toBinary, agent } = _requireProto();

    // Build the content[] array of MCP items
    function buildContentItems(items) {
      const out = [];
      for (const it of items || []) {
        if (!it) continue;
        if (it.kind === 'image' && it.data && it.data.length > 0) {
          out.push(create(agent.McpToolResultContentItemSchema, {
            content: {
              case: 'image',
              value: create(agent.McpImageContentSchema, {
                mimeType: it.mediaType || 'image/png',
                data: it.data instanceof Uint8Array ? it.data : new Uint8Array(it.data),
              }),
            },
          }));
        } else if (it.kind === 'text' && it.text) {
          out.push(create(agent.McpToolResultContentItemSchema, {
            content: { case: 'text', value: create(agent.McpTextContentSchema, { text: it.text }) },
          }));
        }
      }
      // Fallback if everything was filtered out
      if (out.length === 0) {
        out.push(create(agent.McpToolResultContentItemSchema, {
          content: { case: 'text', value: create(agent.McpTextContentSchema, { text: '' }) },
        }));
      }
      return out;
    }

    let mcpResult;
    let summary = 'ok';
    if (content && typeof content === 'object' && content.error) {
      mcpResult = create(agent.McpResultSchema, {
        result: { case: 'error', value: create(agent.McpErrorSchema, { error: String(content.error) }) },
      });
      summary = `error: ${String(content.error).slice(0, 60)}`;
    } else if (content && typeof content === 'object' && Array.isArray(content.items)) {
      const items = buildContentItems(content.items);
      mcpResult = create(agent.McpResultSchema, {
        result: {
          case: 'success',
          value: create(agent.McpSuccessSchema, { content: items, isError: false }),
        },
      });
      const text = content.items.filter(i => i.kind === 'text').length;
      const image = content.items.filter(i => i.kind === 'image').length;
      summary = `text=${text} image=${image}`;
    } else {
      const text = typeof content === 'string' ? content
        : (content == null ? '' : JSON.stringify(content));
      mcpResult = create(agent.McpResultSchema, {
        result: {
          case: 'success',
          value: create(agent.McpSuccessSchema, {
            content: [
              create(agent.McpToolResultContentItemSchema, {
                content: { case: 'text', value: create(agent.McpTextContentSchema, { text }) },
              }),
            ],
            isError: false,
          }),
        },
      });
    }
    console.log(`[cursor-agent] sending tool result execId=${execId} ${summary}`);
    sendExecClientMessage(id, execId, 'mcpResult', mcpResult, sendBinaryFrame);
  }

  // Top-level server message dispatch
  function handleServerMessage(msg) {
    const msgCase = msg.message?.case;

    if (msgCase === 'execServerMessage') {
      markUsefulFrame();
      const exec = msg.message.value;
      const mcpToolDefs = state.mcpToolDefs;
      handleExecMessage(exec, mcpToolDefs, sendBinaryFrame, (info) => {
        // Tool calls are user-visible content; once we forward one, retrying
        // the stream would duplicate it for the client.
        hasEmittedContent = true;
        streamMcpCallCount++;
        currentCallbacks.onMcpCall(info);
      });
      return;
    }
    if (msgCase === 'kvServerMessage') {
      markUsefulFrame();
      handleKvMessage(msg.message.value, blobStore, sendBinaryFrame);
      return;
    }
    if (msgCase === 'interactionUpdate') {
      const iu = msg.message.value;
      const iuCase = iu.message?.case;
      const iuVal = iu.message?.value;

      // Heartbeats deliberately do NOT mark a useful frame — they are
      // exactly what the watchdog has to ignore. Everything else is
      // forward progress, including stepStarted/Completed which are tiny
      // but indicate the model is actively working.
      if (iuCase === 'heartbeat') return;
      markUsefulFrame();
      if (iuCase === 'textDelta') {
        const t = iuVal?.text || '';
        if (t) {
          hasEmittedContent = true;
          _turnTextDeltaCount++;
          currentCallbacks.onTextDelta(t);
        }
        return;
      }
      if (iuCase === 'thinkingDelta') {
        const t = iuVal?.text || '';
        // Thinking is also user-visible content (claude-code renders it).
        if (t) {
          hasEmittedContent = true;
          _turnThinkingDeltaCount++;
          currentCallbacks.onThinkingDelta(t);
        }
        return;
      }
      if (iuCase === 'thinkingCompleted') return;
      if (iuCase === 'tokenDelta') {
        outputTokens += iuVal?.tokens || 0;
        return;
      }
      if (iuCase === 'stepStarted') return;
      if (iuCase === 'stepCompleted') {
        // Bubble up so server.js can finalize a tool_use turn immediately
        // when a step finishes — saves the 250 ms parallel-tool debounce on
        // the common single-tool case.
        try { currentCallbacks.onStepCompleted && currentCallbacks.onStepCompleted(); }
        catch (e) { /* ignore */ }
        return;
      }
      if (iuCase === 'turnEnded') {
        // Note: turnEnded message has no fields per the proto def.
        // Token counts have been accumulated via tokenDelta and the
        // checkpoint update.
        console.log(
          `[cursor-agent] turn ended in=${inputTokens} out=${outputTokens} ` +
          `state=${capturedState ? capturedState.length + 'B' : 'null'}`
        );
        turnEndedFired = true;
        // Record the turn's max idle gap into the per-model rolling window so
        // future turns of this model get a data-driven threshold. Successful
        // turns only — failed turns are not recorded (would skew p99 down).
        try { stallThresholds.recordTurn(modelId, maxIdleMs); } catch { /* ignore */ }
        try {
          currentCallbacks.onTurnEnded({
            inputTokens, outputTokens, conversationState: capturedState,
            maxIdleMs,
            stallThresholdSource: _stallSource,
            turnRetries: _turnRetries,
            turnTransportErrors: _turnTransportErrors,
            turnStalls: _turnStalls,
            turnCascadeDetected: _turnCascadeDetected,
          });
        } catch (e) {
          console.log(`[cursor-agent] onTurnEnded threw: ${e.message}`);
        }
        return;
      }
      // Misc updates we don't render: toolCallStarted/Delta/Completed,
      // partialToolCall, summary*, shellOutputDelta, userMessageAppended
      return;
    }
    if (msgCase === 'conversationCheckpointUpdate') {
      markUsefulFrame();
      const stateStruct = msg.message.value;
      if (stateStruct?.tokenDetails) {
        // totalTokens (used) tracks input+output combined; we keep
        // the simple in/out split based on tokenDelta + final state.
        const used = Number(stateStruct.tokenDetails.usedTokens || 0);
        // Treat the difference as input usage for callers that want it.
        const probeOutput = outputTokens || 0;
        inputTokens = Math.max(0, used - probeOutput);
      }
      try {
        const { toBinary, agent } = _requireProto();
        capturedState = Buffer.from(toBinary(agent.ConversationStateStructureSchema, stateStruct));
      } catch (e) {
        if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] checkpoint encode failed: ${e.message}`);
      }
      return;
    }
    if (msgCase === 'interactionQuery') {
      markUsefulFrame();
      handleInteractionQuery(msg.message.value, sendBinaryFrame);
      return;
    }
    if (msgCase === 'execServerControlMessage') {
      // Server-side control message — counts as forward progress so the
      // watchdog doesn't trip on a stream that's actively orchestrating.
      markUsefulFrame();
      return;
    }

    if (process.env.CURSOR_AGENT_DEBUG) {
      console.log(`[cursor-agent][debug] unhandled server case=${msgCase}`);
    }
  }

  // Holds runtime state + pre-encoded mcpTools used by handleExecMessage.
  const state = { mcpToolDefs: [] };

  // Frame parser: connect frames are [flags(1)][len(4 BE)][payload].
  //
  // Hot path optimization: the obvious `buffer = Buffer.concat([buffer, chunk])`
  // every call is O(n²) when many chunks arrive, because each concat copies the
  // entire carry buffer. Instead, only concat when there's a leftover partial
  // frame from a previous chunk — the common case (chunk lands aligned to one
  // or more whole frames) skips the copy entirely and parses straight from
  // `chunk`. After the loop we either replace `buffer` with the trailing slice
  // (zero-copy via Buffer.slice) or reset to the empty buffer.
  const _emptyBuf = Buffer.alloc(0);
  function parseFrames(chunk) {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] data chunk ${chunk.length}B`);
    // If we have leftover partial-frame bytes from last call, glue them onto
    // this chunk; otherwise parse from the chunk directly.
    const work = (buffer.length > 0) ? Buffer.concat([buffer, chunk]) : chunk;
    let offset = 0;
    while (offset + 5 <= work.length) {
      const flags = work[offset];
      const len = work.readUInt32BE(offset + 1);
      if (offset + 5 + len > work.length) break;
      const payload = work.slice(offset + 5, offset + 5 + len);
      offset += 5 + len;

      if (flags & CONNECT_END_STREAM_FLAG) {
        // Connect end-stream — payload is JSON describing trailers.
        try {
          const json = JSON.parse(payload.toString('utf8'));
          if (json && json.error) {
            const code = json.error.code || 'unknown';
            // The top-level "message" is often a generic "Error". The real
            // detail lives under details[].debug.details.detail (Cursor's
            // aiserver.v1.ErrorDetails wrapper). Walk the array and surface
            // the first useful detail/error string we find.
            let message = json.error.message || 'Unknown error';
            const dets = Array.isArray(json.error.details) ? json.error.details : [];
            for (const d of dets) {
              const debug = d && d.debug;
              if (!debug) continue;
              const innerDetail = debug.details && (debug.details.detail || debug.details.title);
              const innerErr = debug.error;
              if (innerDetail) {
                message = innerDetail + (debug.details.title && debug.details.title !== innerDetail ? ` (${debug.details.title})` : '');
                if (innerErr && innerErr !== 'ERROR_UNKNOWN') message += ` [${innerErr}]`;
                break;
              }
              if (innerErr) {
                message = `${innerErr}`;
                break;
              }
            }
            fail(`Connect error ${code}: ${message}`);
          }
        } catch (e) {
          if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] end-stream parse: ${e.message}`);
        }
        continue;
      }

      try {
        const { fromBinary, agent } = _requireProto();
        const msg = fromBinary(agent.AgentServerMessageSchema, new Uint8Array(payload));
        handleServerMessage(msg);
      } catch (e) {
        if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] decode failed: ${e.message}`);
      }
    }
    // Keep only the trailing partial-frame bytes for next call. If we
    // consumed everything, drop the buffer to the shared empty constant
    // — avoids holding a reference to a long Buffer just because we
    // sliced off the end.
    buffer = (offset < work.length) ? work.slice(offset) : _emptyBuf;
  }

  // Track first-byte arrival so we know whether a stream-level error is
  // safe to retry. NGHTTP2_REFUSED_STREAM before any data = server didn't
  // process the request, fully retryable on a fresh connection.
  let hasReceivedData = false;
  // Tracks whether we've forwarded any user-visible content to the client
  // (text / thinking / tool_use). Once true, retrying mid-stream would
  // produce duplicate content for the client, so we don't retry past this
  // point even on otherwise-retryable errors. Set in handleServerMessage.
  let hasEmittedContent = false;
  let retryAttempts = 0;
  // Tracks whether the previous error was a transport-level cascade signal
  // (REFUSED_STREAM / GOAWAY / INTERNAL_ERROR before content). Two of these
  // in a row mean Cursor's LB is in bad state, not just one bad slot —
  // failOrRetry doubles the next backoff in that case to actually let the
  // LB stabilize before we hammer it again.
  let lastErrorWasTransport = false;
  // 5 attempts gives us coverage past Cursor's typical 1-2 second LB hiccup
  // without exhausting on the first cascade. Was 3, but we observed cascades
  // that recovered just past our last retry — bumped to 5 so the longer
  // backoff schedule (last delay up to ~5 s) lands on a recovered LB.
  const MAX_REQUEST_RETRIES = 5;
  let cachedInitialEncoded = null;
  // Hold the H2 client we attached to so failOrRetry / poisonSharedClient
  // can target the specific bad pool slot without rescanning the pool.
  let attachedClient = null;

  function startConnection(proto) {
    if (connectionStarted) return;
    connectionStarted = true;
    attemptConnection(proto);

    // Build mcpTools once and stash for handleExecMessage / runRequest
    state.mcpToolDefs = buildMcpToolDefinitions(tools || []);

    // Build runRequest
    const { create, toBinary, agent } = proto;
    let stateStruct;
    if (conversationState) {
      let bytes;
      if (Buffer.isBuffer(conversationState)) bytes = new Uint8Array(conversationState);
      else if (conversationState instanceof Uint8Array) bytes = conversationState;
      else if (typeof conversationState === 'string') {
        try { bytes = new Uint8Array(Buffer.from(conversationState, 'base64')); } catch { bytes = null; }
      }
      if (bytes && bytes.length > 0) {
        try {
          stateStruct = proto.fromBinary(agent.ConversationStateStructureSchema, bytes);
        } catch (e) {
          if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] state decode failed: ${e.message}`);
        }
      }
    }
    if (!stateStruct) {
      stateStruct = create(agent.ConversationStateStructureSchema, {
        rootPromptMessagesJson: [],
        turns: [],
        todos: [],
        pendingToolCalls: [],
        previousWorkspaceUris: [],
        fileStates: {},
        fileStatesV2: {},
        summaryArchives: [],
        turnTimings: [],
        subagentStates: {},
        selfSummaryCount: 0,
        readPaths: [],
      });
    }

    const userMsg = create(agent.UserMessageSchema, {
      text: prompt,
      messageId: uuidv4(),
    });
    const action = create(agent.ConversationActionSchema, {
      action: {
        case: 'userMessageAction',
        value: create(agent.UserMessageActionSchema, { userMessage: userMsg }),
      },
    });
    // maxMode opt-in only. Setting it changes Cursor's per-token billing
    // and on some Cursor accounts triggers ERROR_PROVIDER_ERROR even for
    // single-tool requests. Default off; users can pass options.maxMode=true
    // when they actually need the extended budget.
    const enableMaxMode = !!options.maxMode;
    const modelDetails = create(agent.ModelDetailsSchema, {
      modelId,
      displayModelId: modelId,
      displayName: modelId,
      displayNameShort: modelId,
      maxMode: enableMaxMode,
    });

    const runRequestFields = {
      conversationState: stateStruct,
      action,
      modelDetails,
      conversationId,
    };
    // NOTE: tools go ONLY via RequestContext.tools (sent in
    // requestContextResult after Cursor asks for it). We deliberately do NOT
    // duplicate them in runRequest.mcpTools — that would double the tool
    // payload bytes and push us over Cursor's upstream provider tool budget
    // (~30KB schema-bytes threshold). The reference proxy
    // (opencode-cursor) only uses RequestContext.tools.
    // Also enable max_mode on requestedModel to mirror modelDetails.
    runRequestFields.requestedModel = create(agent.RequestedModelSchema, {
      modelId,
      maxMode: enableMaxMode,
    });
    // customSystemPrompt only set if the caller explicitly provides it.
    // Don't auto-inject — Cursor's upstream rejects unauthorized usage
    // with `unknown option '--system-prompt'`.
    if (options.customSystemPrompt) {
      runRequestFields.customSystemPrompt = String(options.customSystemPrompt);
    }
    const runRequest = create(agent.AgentRunRequestSchema, runRequestFields);
    const wrapper = create(agent.AgentClientMessageSchema, {
      message: { case: 'runRequest', value: runRequest },
    });
    // Log encoded size (helpful for tool-budget tuning).
    const encoded = toBinary(agent.AgentClientMessageSchema, wrapper);
    let toolBytes = 0;
    for (const td of state.mcpToolDefs) {
      try { toolBytes += toBinary(agent.McpToolDefinitionSchema, td).length; } catch { /* ignore */ }
    }
    console.log(
      `[cursor-agent] runRequest tools=${state.mcpToolDefs.length} ` +
      `toolBytes=${toolBytes} totalBytes=${encoded.length} maxMode=${enableMaxMode}`
    );
    // Cache the encoded runRequest bytes so we can resend on auto-retry.
    cachedInitialEncoded = encoded;
    sendBinaryFrame(encoded);

    // Drain any frames queued before req existed
    if (pendingWrites.length > 0) {
      // pending writes were queued via sendBinaryFrame — but they go through req.write,
      // so push the buffered ones now
      const drain = pendingWrites.splice(0);
      for (const p of drain) {
        try { req.write(frameConnectMessage(p)); } catch { /* ignore */ }
      }
    }
    if (process.env.CURSOR_AGENT_DEBUG) {
      console.log(`[cursor-agent][debug] runRequest sent`);
    }
  }

  function attemptConnection(proto) {
    try {
      // Reuse the pre-warmed shared client. HTTP/2 multiplexes streams so
      // many simultaneous /v1/messages calls share one TCP/TLS connection,
      // and the first request after server startup pays no handshake cost.
      client = getSharedClient();
      attachedClient = client;
    } catch (e) {
      currentCallbacks.onError(`Connection failed: ${e.message}`);
      return;
    }

    // Tear down any previous heartbeat (set by a prior attempt).
    if (heartbeat) {
      try { clearInterval(heartbeat); } catch { /* ignore */ }
      heartbeat = null;
    }

    req = client.request(buildHeaders(token, sessionId));
    req.setTimeout(config.cursor.requestTimeout);
    // Reset per-attempt telemetry. We're on a fresh stream now.
    streamOpenedAt = Date.now();
    streamBytesIn = 0;
    streamBytesOut = 0;
    streamMcpCallCount = 0;
    streamSummaryEmitted = false;

    req.on('data', (chunk) => {
      hasReceivedData = true;
      streamBytesIn += chunk.length;
      parseFrames(chunk);
    });
    req.on('response', (headers) => {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] response status=${headers[':status']}`);
    });
    req.on('end', () => {
      if (closed) return;
      // If turnEnded already fired we're in the normal teardown window:
      // close() will run momentarily and clean up. Just stop the heartbeat
      // and mark closed so we don't double-handle.
      if (turnEndedFired) {
        clearInterval(heartbeat);
        if (watchdog) { try { clearInterval(watchdog); } catch { /* ignore */ } watchdog = null; }
        closed = true;
        return;
      }
      // Premature end. Cursor cut the stream before delivering turnEnded
      // — likely upstream shutdown, GOAWAY drain, or a transient hiccup.
      // Don't silently mark closed; surface it so the proxy's HTTP
      // response gets a 5xx instead of hanging. fail() handles cleanup.
      fail('Upstream stream ended before turnEnded');
    });
    req.on('error', (e) => failOrRetry(proto, e.message || 'Stream error', e.code));
    req.on('timeout', () => fail('Request timeout'));

    // ── Connection-level death propagation ──
    // The pool catches goaway/close at the slot level (drops the slot for
    // future requests), but our in-flight stream sometimes never fires
    // 'error' or 'end' when its underlying TCP connection drains. Without
    // this, a GOAWAY-induced silent stall can run for tens of minutes
    // until the wallclock watchdog (below) trips. Attach short-lived
    // listeners that route through failOrRetry — REFUSED_STREAM-shaped so
    // the existing retry path triggers if no content has been emitted yet.
    const onClientGoaway = () => {
      if (closed || turnEndedFired) return;
      failOrRetry(proto, 'NGHTTP2_REFUSED_STREAM (client goaway)', 'ERR_HTTP2_GOAWAY');
    };
    const onClientClose = () => {
      if (closed || turnEndedFired) return;
      failOrRetry(proto, 'NGHTTP2_REFUSED_STREAM (client closed)', 'ERR_HTTP2_CLOSED');
    };
    client.once('goaway', onClientGoaway);
    client.once('close', onClientClose);

    // Heartbeat
    heartbeat = setInterval(() => {
      if (closed) return;
      const { create, toBinary, agent } = proto;
      const hb = create(agent.AgentClientMessageSchema, {
        message: { case: 'clientHeartbeat', value: create(agent.ClientHeartbeatSchema, {}) },
      });
      sendBinaryFrame(toBinary(agent.AgentClientMessageSchema, hb));
    }, config.cursor.heartbeatInterval);

    // ── Stall watchdog ──
    // The req.setTimeout above resets on EVERY chunk including 9-byte
    // server heartbeats, so an effectively-dead stream stays "alive"
    // forever from setTimeout's POV. We need a separate timer keyed on
    // *meaningful* progress (text/thinking/exec/step/checkpoint —
    // updated in handleServerMessage) so we can detect the case where
    // Cursor's backend is heartbeating but no longer advancing.
    //
    // Thresholds are per-model and may be adaptive (see stall-thresholds.js).
    // Recompute at the start of each attempt so any new samples recorded
    // since this run started take effect.
    lastUsefulFrameAt = Date.now();
    maxIdleMs = 0;
    _recomputeStallThresholds();
    if (watchdog) { try { clearInterval(watchdog); } catch { /* ignore */ } }
    watchdog = setInterval(() => {
      if (closed) return;
      // Bridges are reused across continuations: after turnEnded fires, the
      // stream sits idle until the next sendToolResult. We don't want the
      // watchdog to trip in that window — it only watches in-flight turns.
      // sendToolResult resets lastUsefulFrameAt as the new turn's start.
      if (turnEndedFired) return;
      const idle = Date.now() - lastUsefulFrameAt;
      const threshold = hasEmittedContent ? _stallPostMs : _stallPreMs;
      if (idle > threshold) {
        try { clearInterval(watchdog); } catch { /* ignore */ }
        watchdog = null;
        // Tell the threshold module so the next attempt for this model gets
        // an elevated threshold (multiplicative bump, decays over time).
        // Successful turns reset the elevation back to baseline.
        try { stallThresholds.recordStall(modelId); } catch { /* ignore */ }
        _turnStalls++;
        const msg = `Upstream stalled — no progress for ${Math.round(idle / 1000)}s`;
        // Route stalls through failOrRetry so an early stall (before any
        // content was emitted to the client) gets the same retry-on-
        // fresh-slot treatment as REFUSED_STREAM. Once content has been
        // emitted, failOrRetry's hasEmittedContent guard turns this into
        // a plain fail anyway — same outcome, but no missed retry on
        // the empty-stream case.
        failOrRetry(proto, `NGHTTP2_INTERNAL_ERROR (${msg})`, 'ERR_HTTP2_STALL');
      }
    }, Math.min(15000, Math.max(5000, Math.floor(_stallPreMs / 4))));
  }

  // Retry-aware error handler. Auto-retries when ALL of:
  //   - We haven't forwarded any user-visible content to the client yet
  //     (so a fresh attempt won't produce duplicate output)
  //   - The error is one of the H2-spec-retryable codes:
  //       REFUSED_STREAM   — server didn't process the request
  //       INTERNAL_ERROR   — server hit an internal hiccup; safe to retry
  //                          if we haven't committed output yet
  //   - We're under the retry budget
  // Mid-stream errors (after content emitted) bubble to onError unchanged
  // so the client can decide to retry from its end.
  function failOrRetry(proto, msg, code) {
    if (closed) return;
    const isTransient =
      /NGHTTP2_REFUSED_STREAM|REFUSED_STREAM/i.test(msg) ||
      /NGHTTP2_INTERNAL_ERROR|INTERNAL_ERROR/i.test(msg) ||
      (code === 'ERR_HTTP2_STREAM_ERROR' && /REFUSED_STREAM|INTERNAL_ERROR/i.test(msg));

    // Always tell the pool slot tracker about the error — it'll evict the
    // slot once it hits the threshold, regardless of whether we retry here.
    if (isTransient) reportSlotError(attachedClient, msg);

    const safeToRetry = !hasEmittedContent && retryAttempts < MAX_REQUEST_RETRIES && isTransient;
    // Dump the per-stream summary BEFORE we decide retry vs fail. That way
    // we see the state at every error event, including ones that succeed
    // on retry (which would otherwise leave no breadcrumb in the log).
    dumpStreamSummary(msg, code || 'stream-error');
    if (safeToRetry) {
      retryAttempts++;
      _turnRetries++;
      console.log(`[cursor-agent] retrying after ${msg} (${retryAttempts}/${MAX_REQUEST_RETRIES}) hasReceivedData=${hasReceivedData}`);
      poisonSharedClient(msg, client);
      // Reset the dedupe flag so the NEXT error on the new stream gets its
      // own summary line (each retry attempt has its own ageMs, byte counts,
      // etc.; we want them logged separately).
      streamSummaryEmitted = false;
      // Detach from the dead stream so its trailing 'end' event doesn't
      // flip `closed = true` and short-circuit the retry. Same for the
      // heartbeat — it would otherwise keep writing to the destroyed req.
      if (req) {
        try { req.removeAllListeners(); } catch { /* ignore */ }
        try { req.destroy(); } catch { /* ignore */ }
      }
      if (heartbeat) {
        try { clearInterval(heartbeat); } catch { /* ignore */ }
        heartbeat = null;
      }
      if (watchdog) {
        try { clearInterval(watchdog); } catch { /* ignore */ }
        watchdog = null;
      }
      // Exponential backoff schedule: 100, 250, 750, 2000, 5000 ms.
      //
      // When Cursor's LB cycles its pool, all our slots receive GOAWAY in a
      // tight burst — without backoff the retries land on brand-new but
      // still-draining connections and cascade. The wider gap on later
      // attempts gives the LB time to stabilize.
      //
      // Cascade detection: if THIS error and the PREVIOUS error were both
      // transport-level (REFUSED_STREAM / GOAWAY / INTERNAL_ERROR before
      // content), we're in an LB cascade and our normal backoff is too
      // tight. Double the delay in that case (capped at 8 s).
      const isTransportError = /REFUSED_STREAM|GOAWAY|INTERNAL_ERROR/i.test(msg);
      const inCascade = isTransportError && lastErrorWasTransport;
      if (isTransportError) _turnTransportErrors++;
      if (inCascade) _turnCascadeDetected = true;
      const baseBackoffs = [100, 250, 750, 2000, 5000];
      const baseMs = baseBackoffs[Math.min(retryAttempts - 1, baseBackoffs.length - 1)];
      const backoffMs = Math.min(8000, baseMs * (inCascade ? 2 : 1));
      lastErrorWasTransport = isTransportError;
      if (inCascade && process.env.CURSOR_AGENT_DEBUG) {
        console.log(`[cursor-agent][debug] cascade detected — backoff ${baseMs}ms × 2 = ${backoffMs}ms`);
      }
      setTimeout(() => {
        if (closed) return;
        try { attemptConnection(proto); } catch (e) {
          fail(`Retry failed: ${e.message}`);
          return;
        }
        // attemptConnection may have failed to get a client (signals via
        // currentCallbacks.onError instead of throwing). Don't try to write
        // on a stale/destroyed req in that case.
        if (!req || req.destroyed) return;
        // Re-send the initial runRequest on the new stream.
        if (cachedInitialEncoded) {
          sendBinaryFrame(cachedInitialEncoded);
        }
        // Re-drain anything that was queued.
        if (pendingWrites.length > 0) {
          const drain = pendingWrites.splice(0);
          for (const p of drain) {
            try { req.write(frameConnectMessage(p)); } catch { /* ignore */ }
          }
        }
      }, backoffMs);
      return;
    }
    // No retry — surface a clean error to claude-code. Stalls were wrapped
    // in `NGHTTP2_INTERNAL_ERROR (...)` to flow through the retry path,
    // but if we're falling through to fail() the H2 framing is misleading.
    // Strip it back to the original "Upstream stalled — ..." message.
    const stallMatch = /^NGHTTP2_INTERNAL_ERROR \((Upstream stalled — [^)]+)\)$/.exec(msg);
    fail(stallMatch ? stallMatch[1] : msg);
  }

  // Kick off the connection. If the proto module isn't loaded yet (pre-warm
  // is async), wait for it.
  if (_protoMod) {
    startConnection(_protoMod);
  } else {
    loadProto().then((proto) => {
      if (closed) return;
      startConnection(proto);
    }).catch((e) => fail(`proto load failed: ${e.message}`));
  }

  return {
    conversationId,
    sendToolResult,
    setCallbacks,
    close,
    // Latest known token counts. server.js's finalizeToolUseTurn fires
    // before onTurnEnded, but conversationCheckpointUpdate frames may have
    // already landed and populated these — exposing them lets the caller
    // emit accurate input_tokens in the streaming message_delta even on
    // the early-finalize path used for tool_use turns.
    getStats: () => {
      const now = Date.now();
      const idleMs = lastUsefulFrameAt > 0 ? now - lastUsefulFrameAt : 0;
      const thresholdMs = hasEmittedContent ? _stallPostMs : _stallPreMs;
      return {
        // Token counts
        inputTokens, outputTokens,
        // Per-turn aggregate signals (final values after turnEnded)
        maxIdleMs,
        turnRetries: _turnRetries,
        turnTransportErrors: _turnTransportErrors,
        turnStalls: _turnStalls,
        turnCascadeDetected: _turnCascadeDetected,
        // Live diagnostics (meaningful while the bridge is in-flight)
        modelId,
        closed,
        turnEndedFired,
        hasEmittedContent,
        streamOpenedAt,
        openedMsAgo: streamOpenedAt > 0 ? now - streamOpenedAt : null,
        lastUsefulFrameAt,
        idleMsSinceLastUsefulFrame: lastUsefulFrameAt > 0 ? idleMs : null,
        currentThresholdMs: thresholdMs,
        currentThresholdKind: hasEmittedContent ? 'post-content' : 'pre-content',
        willTripStallInMs: lastUsefulFrameAt > 0 ? Math.max(0, thresholdMs - idleMs) : null,
        stallThresholdSource: _stallSource,
        retryAttempts,
        bytesInTotal: streamBytesIn,
        bytesInSinceLastUsefulFrame: streamBytesIn - _bytesInAtLastUsefulFrame,
        bytesOutTotal: streamBytesOut,
        textDeltaCount: _turnTextDeltaCount,
        thinkingDeltaCount: _turnThinkingDeltaCount,
        mcpCallCount: streamMcpCallCount,
      };
    },
  };
}

module.exports = {
  startConversation,
  decodeMcpArgs,
  encodeValue,
  decodeValueBytes,
  deterministicConversationId,
  encodeFrame,
  buildHeaders,
  loadProto,
  prewarmSharedClient,
};
