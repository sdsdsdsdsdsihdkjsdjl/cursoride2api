// ═══════════════════════════════════════════════
//  CursorIDE2API — Cursor ChatService client
//  application/connect+proto (binary protobuf)
//  RPC: aiserver.v1.ChatService.StreamUnifiedChatWithTools
// ═══════════════════════════════════════════════
//
// Why this exists alongside cursor-agent.js:
//
// Cursor exposes two transports for Anthropic-family models:
//   - agent.v1.AgentService/Run   — what cursor-agent.js uses today.
//     Streams `thinkingDelta` text deltas with no signature companion;
//     thinking signatures are stripped at this boundary, so cross-turn
//     thinking continuity is impossible on this path.
//   - aiserver.v1.ChatService/StreamUnifiedChatWithTools — this module.
//     Carries `ConversationMessage.Thinking { text, signature,
//     redacted_thinking, is_last_thinking_chunk }` in both directions,
//     preserving Anthropic's signed thinking blocks end-to-end. The
//     same RPC Cursor IDE uses internally for its chat panel.
//
// Scope of this initial implementation:
//   - Text-and-thinking turns only. The chat RPC has a tool surface
//     (`supported_tools`, `mcp_tools`, `tool_results` on ConversationMessage)
//     but the wire shape for tool registration + call extraction was not
//     fully reverse-engineered as part of this work. Requests carrying tools
//     should route through cursor-agent.js (the existing tool-aware path).
//
// Bridge interface intentionally matches cursor-agent.js's so server.js can
// switch via env flag (CURSOR_USE_CHAT_SERVICE=1) with minimal call-site
// differences.

const http2 = require('http2');
const crypto = require('crypto');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');
const { create, toBinary, fromBinary } = require('@bufbuild/protobuf');
const config = require('./config');
const { generateChecksum } = require('./cursor-client');

// Connect-protocol streaming-frame format:
//   [1 byte flags][4 bytes BE uint32 length][N bytes payload]
// Flags bit 0 (0x01) = "compressed". Bit 1 (0x02) reserved (here used for
// the JSON trailer the Connect spec emits on stream end).
const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;

// Cache timezone — Intl.DateTimeFormat() does non-trivial work at every
// resolve, and the answer is constant for the process lifetime.
const _cursorTimezone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

const _clientType = process.env.CURSOR_CLIENT_TYPE || 'ide';
const _clientOs = process.env.CURSOR_CLIENT_OS || (process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows_nt' : 'linux');
const _clientArch = process.env.CURSOR_CLIENT_ARCH || (process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch);
const _clientDevice = process.env.CURSOR_CLIENT_DEVICE_TYPE || 'desktop';
const _clientOsVersion = process.env.CURSOR_CLIENT_OS_VERSION || (require('os').release ? require('os').release() : '');
const _clientCommit = process.env.CURSOR_COMMIT || 'd5c0e77a0214208f36b56d42e8e787de88d02ea4';
const _baseUrl = config.cursor.baseUrl;

// Lazy proto loader. Mirrors cursor-agent's pattern so importing this file
// doesn't pay the proto-load cost unless someone actually uses ChatService.
let _protoMod = null;
let _protoLoadPromise = null;
async function loadProto() {
  if (_protoMod) return _protoMod;
  if (_protoLoadPromise) return _protoLoadPromise;
  _protoLoadPromise = (async () => {
    const chat = await import('./proto/chat_pb.mjs');
    _protoMod = { chat };
    return _protoMod;
  })();
  return _protoLoadPromise;
}
function _requireProto() {
  if (!_protoMod) throw new Error('cursor-chat proto not loaded — call await loadProto() first');
  return _protoMod;
}
async function prewarmSharedClient() {
  // Just load the proto. The H2 pool from cursor-agent.js is reused
  // (see _getH2Client below) so we don't open separate connections here.
  await loadProto();
}

// ── HTTP/2 client (shared with cursor-agent's pool) ──────────────────────
//
// We piggy-back on cursor-agent.js's existing pool — same hostname, same
// connection-level health concerns, no reason to maintain a parallel pool
// just because we hit a different RPC path.
let _cursorAgentMod = null;
function _getH2Client() {
  if (!_cursorAgentMod) _cursorAgentMod = require('./cursor-agent');
  // Use the pool's accessor via an indirection so we don't fight for the
  // private slot management. cursor-agent exposes getSharedClient indirectly
  // through its module — but we need direct access. Use http2.connect for
  // simplicity until/unless pool sharing becomes a problem.
  return http2.connect(_baseUrl, { settings: { initialWindowSize: 1024 * 1024 * 8 } });
}

// ── Connect protocol framing ─────────────────────────────────────────────

function encodeConnectFrame(payload, { compressed = false, endStream = false } = {}) {
  // 5-byte header + payload bytes.
  const len = payload.length;
  const buf = Buffer.alloc(5 + len);
  buf[0] = (compressed ? FLAG_COMPRESSED : 0) | (endStream ? FLAG_END_STREAM : 0);
  buf.writeUInt32BE(len, 1);
  payload.copy(buf, 5);
  return buf;
}

// Pull complete Connect frames out of an accumulating buffer. Returns
// { frames, rest }. Each frame is { flags, payload (Buffer) }.
function parseConnectFrames(buf) {
  const frames = [];
  let offset = 0;
  while (buf.length - offset >= 5) {
    const flags = buf[offset];
    const len = buf.readUInt32BE(offset + 1);
    if (buf.length - offset < 5 + len) break;
    const payload = buf.subarray(offset + 5, offset + 5 + len);
    frames.push({ flags, payload });
    offset += 5 + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

// ── Headers ──────────────────────────────────────────────────────────────

const CHAT_RPC_PATH = process.env.CURSOR_CHAT_RPC_PATH
  || '/aiserver.v1.ChatService/StreamUnifiedChatWithTools';

function buildHeaders(token, sessionId) {
  return {
    ':method': 'POST',
    ':path': CHAT_RPC_PATH,
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'connect-accept-encoding': 'gzip',
    // We *could* set 'connect-content-encoding: gzip' if we gzipped the
    // request body. Cursor accepts both; we don't bother for now.
    te: 'trailers',
    'authorization': `Bearer ${token.accessToken}`,
    'x-cursor-checksum': generateChecksum(token.machineId || '', token.macMachineId || ''),
    'x-cursor-client-version': config.cursor.clientVersion,
    'x-cursor-timezone': _cursorTimezone,
    'x-request-id': uuidv4(),
    'x-session-id': sessionId || uuidv4(),
    'x-ghost-mode': 'false',
    'x-cursor-client-type': _clientType,
    'x-cursor-client-os': _clientOs,
    'x-cursor-client-arch': _clientArch,
    'x-cursor-client-device-type': _clientDevice,
    'x-cursor-client-os-version': _clientOsVersion,
    'x-cursor-commit': _clientCommit,
    'user-agent': 'connect-es/1.6.1',
    'x-amzn-trace-id': `Root=${uuidv4()}`,
    'x-client-key': crypto.createHash('sha256').update(token.accessToken).digest('hex'),
  };
}

// ── Anthropic → Cursor ConversationMessage conversion ────────────────────
//
// We translate the Anthropic Messages API conversation history into the
// repeated ConversationMessage[] expected by StreamUnifiedChatRequest's
// `conversation` field. Thinking blocks from prior assistant messages are
// faithfully placed in `ConversationMessage.thinking` (and
// `.all_thinking_blocks` for multi-block turns) WITH SIGNATURES — that's
// the whole point of this code path.
//
// For text + thinking we have a clean translation. Tool blocks (`tool_use`
// in assistant messages, `tool_result` in user messages) are left for a
// follow-up — they require reverse-engineering the wire shape of
// `ConversationMessage.tool_results` and the response-side tool envelope.

function buildConversation(messages, system, proto) {
  const { ConversationMessageSchema, ConversationMessage_ThinkingSchema, ConversationMessage_MessageType } = proto.chat;
  const createMsg = create;
  const out = [];

  // System prompt: emit as a leading HUMAN message tagged as system. The
  // chat RPC's ConversationMessage doesn't have a dedicated system slot,
  // so we mimic Cursor IDE behavior — prepend the system text as a HUMAN
  // turn the model treats as instructions.
  if (system) {
    const sysText = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
        : '';
    if (sysText) {
      out.push(createMsg(ConversationMessageSchema, {
        text: `<system>\n${sysText}\n</system>`,
        type: ConversationMessage_MessageType.HUMAN,
        bubbleId: uuidv4(),
      }));
    }
  }

  for (const msg of messages || []) {
    if (!msg) continue;
    const role = msg.role || 'user';
    let text = '';
    const thinkingBlocks = [];

    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textSegments = [];
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          textSegments.push(b.text);
        } else if (b.type === 'thinking' && (b.thinking || b.signature)) {
          // Preserve the signed thinking block. THIS is the load-bearing
          // part: when claude-code sends back the prior assistant message
          // containing its thinking, we forward text + signature verbatim
          // so Cursor's upstream Anthropic provider can resume reasoning.
          thinkingBlocks.push(createMsg(ConversationMessage_ThinkingSchema, {
            text: b.thinking || '',
            signature: b.signature || '',
            redactedThinking: b.redacted_thinking || '',
            isLastThinkingChunk: b.is_last_thinking_chunk !== false,
          }));
        } else if (b.type === 'tool_use' || b.type === 'tool_result') {
          // Tool blocks are out of scope for this initial cursor-chat
          // implementation — record their text content (if any) so the
          // model has SOME context, but don't try to map them to Cursor's
          // tool envelope.
          if (b.type === 'tool_use') {
            try { textSegments.push(`[Tool call: ${b.name}(${JSON.stringify(b.input || {})})]`); } catch { /* ignore */ }
          } else if (b.type === 'tool_result') {
            let resultText = '';
            if (typeof b.content === 'string') resultText = b.content;
            else if (Array.isArray(b.content)) {
              resultText = b.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
            }
            if (resultText) textSegments.push(`[Tool result for ${b.tool_use_id || '?'}: ${resultText}]`);
          }
        }
      }
      text = textSegments.join('\n');
    }

    const cm = createMsg(ConversationMessageSchema, {
      text,
      type: role === 'assistant'
        ? ConversationMessage_MessageType.AI
        : ConversationMessage_MessageType.HUMAN,
      bubbleId: uuidv4(),
    });
    if (thinkingBlocks.length > 0) {
      // Both fields are populated — `thinking` is the head block (Cursor
      // IDE expects at least one for the conversation to be flagged as
      // having reasoning), `all_thinking_blocks` carries the full ordered
      // list for multi-step reasoning continuity.
      cm.thinking = thinkingBlocks[0];
      cm.allThinkingBlocks = thinkingBlocks;
    }
    out.push(cm);
  }

  return out;
}

function buildStreamUnifiedChatRequest({
  messages, system, modelId, conversationId, isHeadless = true, thinkingLevel = null,
}, proto) {
  const {
    StreamUnifiedChatRequestSchema,
    ModelDetailsSchema,
    StreamUnifiedChatRequest_ThinkingLevel,
  } = proto.chat;
  const createMsg = create;

  const conversation = buildConversation(messages, system, proto);
  const modelDetails = createMsg(ModelDetailsSchema, {
    modelName: modelId,
  });

  const reqInit = {
    conversation,
    modelDetails,
    conversationId: conversationId || uuidv4(),
    isChat: true,
    isHeadless,
    // is_agentic: false for now — agent-mode tool dispatch is out of scope.
  };
  // Thinking level is the request-side knob for "use extended thinking".
  // claude-code's --effort flag effectively asks for this; we map adaptive
  // through to HIGH.
  if (thinkingLevel === 'high' || thinkingLevel === 'max') {
    reqInit.thinkingLevel = StreamUnifiedChatRequest_ThinkingLevel.HIGH;
  } else if (thinkingLevel === 'medium') {
    reqInit.thinkingLevel = StreamUnifiedChatRequest_ThinkingLevel.MEDIUM;
  }
  return createMsg(StreamUnifiedChatRequestSchema, reqInit);
}

// ── Bridge: startConversation ────────────────────────────────────────────
//
// Returns an object matching cursor-agent.js's bridge contract enough for
// server.js to swap between transports via env flag:
//   - close()
//   - getStats() → { inputTokens, outputTokens, ... }
//   - setCallbacks(newCallbacks)
//   - NOT sendToolResult — chat service is single-shot per turn; if the
//     caller tries to call this we throw so the bug surfaces immediately.
function startConversation(token, options) {
  if (!token || !token.accessToken) throw new Error('startConversation: missing token.accessToken');
  const {
    messages = [],
    system,
    modelId,
    conversationId,
    sessionId = uuidv4(),
    thinkingLevel,
    onTextDelta,
    onThinkingDelta,
    onMcpCall,
    onStepCompleted,
    onTurnEnded,
    onError,
  } = options || {};

  const onSignatureDelta = options.onSignatureDelta;
  const currentCallbacks = {
    onTextDelta: onTextDelta || (() => {}),
    onThinkingDelta: onThinkingDelta || (() => {}),
    // Chat-service-specific: fires when an `is_last_thinking_chunk: true`
    // Thinking message arrives, carrying the cryptographic signature for
    // the thinking block just streamed. server.js translates it into an
    // Anthropic `signature_delta` SSE event so claude-code stores it with
    // the thinking block for cross-turn resume.
    onSignatureDelta: onSignatureDelta || (() => {}),
    onMcpCall: onMcpCall || (() => {}),
    onStepCompleted: onStepCompleted || (() => {}),
    onTurnEnded: onTurnEnded || (() => {}),
    onError: onError || (() => {}),
  };
  function setCallbacks(nc) {
    if (!nc || typeof nc !== 'object') return;
    for (const k of Object.keys(currentCallbacks)) {
      if (typeof nc[k] === 'function') currentCallbacks[k] = nc[k];
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let lastUsefulFrameAt = Date.now();
  let maxIdleMs = 0;
  let closed = false;
  let client = null;
  let req = null;
  let buffer = Buffer.alloc(0);
  let turnEndedFired = false;
  // Accumulated assistant text + thinking for the current response. We
  // emit deltas as they arrive but also keep the full strings for the
  // final onTurnEnded payload + signature carriage.
  let pendingThinking = '';
  let pendingThinkingSignature = '';
  let pendingThinkingRedacted = '';
  let pendingThinkingComplete = false;
  let allReceivedThinkingBlocks = [];

  function fail(err) {
    if (closed) return;
    closed = true;
    try { req && req.close(); } catch { /* ignore */ }
    try { client && client.close(); } catch { /* ignore */ }
    try { currentCallbacks.onError(typeof err === 'string' ? err : err.message); } catch { /* ignore */ }
  }
  function markUseful() {
    const now = Date.now();
    if (lastUsefulFrameAt > 0) {
      const idle = now - lastUsefulFrameAt;
      if (idle > maxIdleMs) maxIdleMs = idle;
    }
    lastUsefulFrameAt = now;
  }

  function handleResponseFrame(payload, flags) {
    markUseful();
    // End-of-stream Connect trailer: a JSON object indicating status.
    if (flags & FLAG_END_STREAM) {
      try {
        const text = payload.toString('utf8');
        if (text.trim()) {
          // Always log trailer when it's non-trivial — these carry the
          // error explanations from Cursor's backend, and we need them
          // visible to diagnose auth / schema issues during migration.
          console.log(`[cursor-chat] trailer: ${text.slice(0, 800)}`);
          let trailer = null;
          try { trailer = JSON.parse(text); } catch { /* ignore */ }
          if (trailer && trailer.error) {
            const errStr = trailer.error.message || JSON.stringify(trailer.error);
            const details = trailer.error.details ? ` | details: ${JSON.stringify(trailer.error.details).slice(0, 500)}` : '';
            return fail(`Cursor chat error: ${errStr}${details}`);
          }
        }
      } catch { /* ignore */ }
      // No error → final turnEnded.
      if (!turnEndedFired) {
        turnEndedFired = true;
        // Build a synthetic "thinking block" we received, including the
        // signature, so the caller can forward it back to claude-code as
        // a signed thinking content block.
        const thinkingBlocks = allReceivedThinkingBlocks.slice();
        if (pendingThinking || pendingThinkingSignature) {
          thinkingBlocks.push({
            text: pendingThinking,
            signature: pendingThinkingSignature,
            redacted_thinking: pendingThinkingRedacted,
            is_last_thinking_chunk: pendingThinkingComplete,
          });
          pendingThinking = '';
          pendingThinkingSignature = '';
          pendingThinkingRedacted = '';
          pendingThinkingComplete = false;
        }
        try {
          currentCallbacks.onTurnEnded({
            inputTokens, outputTokens,
            conversationState: null,
            maxIdleMs,
            thinkingBlocks,  // [{ text, signature, redacted_thinking, is_last_thinking_chunk }]
            stallThresholdSource: 'baseline',
          });
        } catch (e) {
          // swallow
        }
      }
      return;
    }
    // Data frame: gzip-decompress if flagged, then decode the proto.
    let body = payload;
    if (flags & FLAG_COMPRESSED) {
      try { body = zlib.gunzipSync(payload); }
      catch (e) { return fail(`gunzip failed: ${e.message}`); }
    }
    try {
      const proto = _requireProto();
      const useWrapper = CHAT_RPC_PATH.endsWith('WithTools');
      const responseSchema = useWrapper
        ? proto.chat.StreamUnifiedChatResponseWithToolsSchema
        : proto.chat.StreamUnifiedChatResponseSchema;
      const resp = fromBinary(responseSchema, new Uint8Array(body));
      // For the non-wrapper path the response IS the inner ChatResponse;
      // for the wrapper, the inner is at .streamUnifiedChatResponse.
      const inner = useWrapper
        ? (resp.streamUnifiedChatResponse || resp.stream_unified_chat_response)
        : resp;
      handleChatResponse({ streamUnifiedChatResponse: inner });
    } catch (e) {
      if (process.env.CURSOR_AGENT_DEBUG) console.log(`[cursor-chat][debug] decode failed: ${e.message}`);
    }
  }

  function handleChatResponse(resp) {
    // StreamUnifiedChatResponseWithTools is { stream_unified_chat_response, ... }.
    // The streaming text/thinking deltas live on the nested ChatResponse.
    const inner = resp && (resp.streamUnifiedChatResponse || resp.stream_unified_chat_response);
    if (!inner) return;
    // Text content arrives as `text` field on the inner response.
    if (inner.text) {
      outputTokens += Math.ceil(inner.text.length / 4);
      try { currentCallbacks.onTextDelta(inner.text); } catch { /* ignore */ }
    }
    // Thinking content arrives via `thinking` (a ConversationMessage.Thinking).
    const thinking = inner.thinking;
    if (thinking) {
      const text = thinking.text || '';
      if (text) {
        pendingThinking += text;
        try { currentCallbacks.onThinkingDelta(text); } catch { /* ignore */ }
      }
      if (thinking.signature) pendingThinkingSignature = thinking.signature;
      if (thinking.redactedThinking) pendingThinkingRedacted = thinking.redactedThinking;
      if (thinking.isLastThinkingChunk) {
        pendingThinkingComplete = true;
        // Fire signature delta NOW (before any subsequent text or another
        // thinking block) so server.js can append it to the still-open
        // thinking content block in the SSE stream.
        if (pendingThinkingSignature) {
          try { currentCallbacks.onSignatureDelta(pendingThinkingSignature); } catch { /* ignore */ }
        }
        // Snapshot the completed block — more thinking blocks may follow.
        allReceivedThinkingBlocks.push({
          text: pendingThinking,
          signature: pendingThinkingSignature,
          redacted_thinking: pendingThinkingRedacted,
          is_last_thinking_chunk: true,
        });
        pendingThinking = '';
        pendingThinkingSignature = '';
        pendingThinkingRedacted = '';
        pendingThinkingComplete = false;
      }
    }
    // Token usage updates come in `usage` or similar — best effort.
    const usage = inner.usage || inner.usageInfo || null;
    if (usage) {
      const input = Number(usage.inputTokens || usage.input_tokens || 0);
      const output = Number(usage.outputTokens || usage.output_tokens || 0);
      if (input > 0) inputTokens = input;
      if (output > 0) outputTokens = output;
    }
  }

  async function send() {
    try {
      const proto = await loadProto();
      const innerRequest = buildStreamUnifiedChatRequest({
        messages, system, modelId, conversationId, thinkingLevel,
      }, proto);
      // StreamUnifiedChatWithTools takes a wrapper that holds the inner
      // request at field 1 + an optional tool result at field 2. The
      // simpler StreamUnifiedChat takes StreamUnifiedChatRequest directly.
      // Pick encoding based on the configured RPC path.
      const useWrapper = CHAT_RPC_PATH.endsWith('WithTools');
      let body;
      if (useWrapper) {
        const wrapped = create(proto.chat.StreamUnifiedChatRequestWithToolsSchema, {
          streamUnifiedChatRequest: innerRequest,
        });
        body = Buffer.from(toBinary(proto.chat.StreamUnifiedChatRequestWithToolsSchema, wrapped));
      } else {
        body = Buffer.from(toBinary(proto.chat.StreamUnifiedChatRequestSchema, innerRequest));
      }
      const frame = encodeConnectFrame(body);

      client = _getH2Client();
      client.unref();
      client.on('error', (e) => fail(`H2 connect error: ${e.message}`));
      client.on('goaway', () => fail('H2 GOAWAY'));
      client.on('close', () => { if (!closed && !turnEndedFired) fail('H2 client closed'); });

      req = client.request(buildHeaders(token, sessionId));
      req.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const { frames, rest } = parseConnectFrames(buffer);
        buffer = rest;
        for (const f of frames) handleResponseFrame(f.payload, f.flags);
      });
      req.on('end', () => {
        // Stream ended without explicit end-stream frame — still finalize.
        if (!turnEndedFired) {
          turnEndedFired = true;
          try {
            currentCallbacks.onTurnEnded({
              inputTokens, outputTokens,
              conversationState: null,
              maxIdleMs,
              thinkingBlocks: allReceivedThinkingBlocks.slice(),
              stallThresholdSource: 'baseline',
            });
          } catch { /* ignore */ }
        }
      });
      req.on('error', (e) => fail(`H2 stream error: ${e.message}`));
      // Write the single Connect-framed request, then signal end-of-input.
      req.write(frame);
      req.end();
    } catch (e) {
      fail(e);
    }
  }

  // Fire-and-forget: bridge is returned synchronously; the network work
  // happens in the background. Callbacks will fire when responses arrive.
  send();

  return {
    close() {
      if (closed) return;
      closed = true;
      try { req && req.close(); } catch { /* ignore */ }
      try { client && client.close(); } catch { /* ignore */ }
    },
    sendToolResult() {
      // Chat service is single-shot per turn. If server.js asks us to
      // continue with a tool result, that's a contract mismatch — the
      // request should have been routed through cursor-agent instead.
      // Surface loudly rather than silently dropping.
      throw new Error('cursor-chat does not implement sendToolResult — route tool-result turns through cursor-agent.js');
    },
    setCallbacks,
    getStats: () => ({
      inputTokens,
      outputTokens,
      maxIdleMs,
      // The fields below exist for interface parity with cursor-agent.js
      // (server.js inspects them on error paths). Chat service doesn't
      // have the retry/cascade plumbing yet so they're constant zero.
      turnRetries: 0,
      turnTransportErrors: 0,
      turnStalls: 0,
      turnCascadeDetected: false,
    }),
  };
}

module.exports = {
  startConversation,
  loadProto,
  prewarmSharedClient,
  // For tests / introspection:
  buildConversation,
  buildStreamUnifiedChatRequest,
  encodeConnectFrame,
  parseConnectFrames,
};
