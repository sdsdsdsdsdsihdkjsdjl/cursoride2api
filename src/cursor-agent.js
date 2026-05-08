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
function buildHeaders(token) {
  return {
    ':method': 'POST',
    ':path': '/agent.v1.AgentService/Run',
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    te: 'trailers',
    'authorization': `Bearer ${token.accessToken}`,
    'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
    'x-cursor-client-version': config.cursor.clientVersion,
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-request-id': uuidv4(),
  };
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
// Cursor's native list isn't documented and is bigger than initial probing
// suggested — it includes (at least, May 2026):
//   Read, Write, Ls, Grep, Delete, Shell, Fetch, WebFetch, Glob,
//   Diagnostics, TodoWrite, ...
//
// Rather than maintain a brittle blocklist, we just prefix EVERY MCP tool's
// wire `name` with `mcp_`. The proto `tool_name` field (and the original
// name) is preserved for the dispatcher / for echoing back to the client.
const MCP_NAME_PREFIX = 'mcp_';

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
    // Always prefix `name` so the upstream tool list never collides with any
    // of Cursor's built-in tool names (the list is bigger than initial probing
    // suggested — Read/Write/Glob/Grep/WebFetch/TodoWrite/... — and undocumented).
    // Keep `toolName` unchanged so Cursor's mcpArgs.toolName still matches the
    // original name the caller registered (no mapping table needed downstream).
    const wireName = t.name.startsWith(MCP_NAME_PREFIX) ? t.name : MCP_NAME_PREFIX + t.name;
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
    onTextDelta,
    onThinkingDelta,
    onMcpCall,
    onTurnEnded,
    onError,
  } = options;

  const currentCallbacks = {
    onTextDelta: onTextDelta || (() => {}),
    onThinkingDelta: onThinkingDelta || (() => {}),
    onMcpCall: onMcpCall || (() => {}),
    onTurnEnded: onTurnEnded || (() => {}),
    onError: onError || (() => {}),
  };

  function setCallbacks(newCallbacks) {
    if (!newCallbacks || typeof newCallbacks !== 'object') return;
    for (const k of ['onTextDelta', 'onThinkingDelta', 'onMcpCall', 'onTurnEnded', 'onError']) {
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
  // Blob store keyed by blobId hex string
  const blobStore = new Map();

  function fail(msg) {
    if (closed) return;
    currentCallbacks.onError(msg);
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { if (req) req.end(); } catch { /* ignore */ }
    setTimeout(() => {
      try { if (req) req.close(); } catch { /* ignore */ }
      try { if (client) client.close(); } catch { /* ignore */ }
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
      req.write(frameConnectMessage(payload));
    } catch (e) {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] write failed: ${e.message}`);
    }
  }

  // Heartbeat — written as a binary connect frame
  let heartbeat = null;

  // sendToolResult: write mcpResult into the live stream
  function sendToolResult(id, execId, content) {
    if (closed) return;
    const { create, toBinary, agent } = _requireProto();
    let mcpResult;
    if (typeof content === 'string') {
      mcpResult = create(agent.McpResultSchema, {
        result: {
          case: 'success',
          value: create(agent.McpSuccessSchema, {
            content: [
              create(agent.McpToolResultContentItemSchema, {
                content: { case: 'text', value: create(agent.McpTextContentSchema, { text: content }) },
              }),
            ],
            isError: false,
          }),
        },
      });
    } else if (content && typeof content === 'object' && content.error) {
      mcpResult = create(agent.McpResultSchema, {
        result: { case: 'error', value: create(agent.McpErrorSchema, { error: String(content.error) }) },
      });
    } else {
      const s = content == null ? '' : (typeof content === 'string' ? content : JSON.stringify(content));
      mcpResult = create(agent.McpResultSchema, {
        result: {
          case: 'success',
          value: create(agent.McpSuccessSchema, {
            content: [
              create(agent.McpToolResultContentItemSchema, {
                content: { case: 'text', value: create(agent.McpTextContentSchema, { text: s }) },
              }),
            ],
            isError: false,
          }),
        },
      });
    }
    console.log(`[cursor-agent] sending tool result execId=${execId} ok=${!content?.error}`);
    sendExecClientMessage(id, execId, 'mcpResult', mcpResult, sendBinaryFrame);
  }

  // Top-level server message dispatch
  function handleServerMessage(msg) {
    const msgCase = msg.message?.case;

    if (msgCase === 'execServerMessage') {
      const exec = msg.message.value;
      const mcpToolDefs = state.mcpToolDefs;
      handleExecMessage(exec, mcpToolDefs, sendBinaryFrame, (info) => currentCallbacks.onMcpCall(info));
      return;
    }
    if (msgCase === 'kvServerMessage') {
      handleKvMessage(msg.message.value, blobStore, sendBinaryFrame);
      return;
    }
    if (msgCase === 'interactionUpdate') {
      const iu = msg.message.value;
      const iuCase = iu.message?.case;
      const iuVal = iu.message?.value;

      if (iuCase === 'heartbeat') return;
      if (iuCase === 'textDelta') {
        const t = iuVal?.text || '';
        if (t) currentCallbacks.onTextDelta(t);
        return;
      }
      if (iuCase === 'thinkingDelta') {
        const t = iuVal?.text || '';
        if (t) currentCallbacks.onThinkingDelta(t);
        return;
      }
      if (iuCase === 'thinkingCompleted') return;
      if (iuCase === 'tokenDelta') {
        outputTokens += iuVal?.tokens || 0;
        return;
      }
      if (iuCase === 'stepCompleted' || iuCase === 'stepStarted') return;
      if (iuCase === 'turnEnded') {
        // Note: turnEnded message has no fields per the proto def.
        // Token counts have been accumulated via tokenDelta and the
        // checkpoint update.
        console.log(
          `[cursor-agent] turn ended in=${inputTokens} out=${outputTokens} ` +
          `state=${capturedState ? capturedState.length + 'B' : 'null'}`
        );
        try {
          currentCallbacks.onTurnEnded({ inputTokens, outputTokens, conversationState: capturedState });
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
    if (msgCase === 'interactionQuery') return;
    if (msgCase === 'execServerControlMessage') return;

    if (process.env.CURSOR_AGENT_DEBUG) {
      console.log(`[cursor-agent][debug] unhandled server case=${msgCase}`);
    }
  }

  // Holds runtime state + pre-encoded mcpTools used by handleExecMessage.
  const state = { mcpToolDefs: [] };

  // Frame parser: connect frames are [flags(1)][len(4 BE)][payload].
  function parseFrames(chunk) {
    if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] data chunk ${chunk.length}B`);
    buffer = Buffer.concat([buffer, chunk]);
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const flags = buffer[offset];
      const len = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + len > buffer.length) break;
      const payload = buffer.slice(offset + 5, offset + 5 + len);
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
    buffer = buffer.slice(offset);
  }

  function startConnection(proto) {
    if (connectionStarted) return;
    connectionStarted = true;
    try {
      client = http2.connect(config.cursor.baseUrl);
    } catch (e) {
      currentCallbacks.onError(`Connection failed: ${e.message}`);
      return;
    }
    client.on('error', (e) => {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client error: ${e.message}`);
    });
    client.on('close', () => {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client closed`);
    });
    client.on('connect', () => {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client connected`);
    });
    client.on('goaway', () => {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] client goaway`);
    });

    req = client.request(buildHeaders(token));
    req.setTimeout(config.cursor.requestTimeout);

    req.on('data', parseFrames);
    req.on('response', (headers) => {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-agent][debug] response status=${headers[':status']}`);
    });
    req.on('end', () => {
      if (closed) return;
      clearInterval(heartbeat);
      if (!closed) {
        closed = true;
        try { client.close(); } catch { /* ignore */ }
      }
    });
    req.on('error', (e) => fail(e.message || 'Stream error'));
    req.on('timeout', () => fail('Request timeout'));

    // Heartbeat
    heartbeat = setInterval(() => {
      if (closed) return;
      const { create, toBinary, agent } = proto;
      const hb = create(agent.AgentClientMessageSchema, {
        message: { case: 'clientHeartbeat', value: create(agent.ClientHeartbeatSchema, {}) },
      });
      sendBinaryFrame(toBinary(agent.AgentClientMessageSchema, hb));
    }, config.cursor.heartbeatInterval);

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
};
