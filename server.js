// ═══════════════════════════════════════════════════
//  CursorIDE2API v2 - 极简版
//  token.json → 反代 Cursor API → OpenAI 兼容接口
// ═══════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cursorClient = require('./src/cursor-client');
const converter = require('./src/converter');
const anthropicConverter = require('./src/anthropic-converter');
const config = require('./src/config');
const cursorAgent = require('./src/cursor-agent');
const anthropicTools = require('./src/anthropic-tools');
const preprocess = require('./src/preprocess');
const debugLog = require('./src/debug-log');
debugLog.init();

// Configurable "small model" used for warmup pings, compaction summarization,
// and (optionally) subagent traffic — costs much less than a full Sonnet/Opus
// turn. Default to the smallest real Claude on Cursor.
const SMALL_MODEL = process.env.SMALL_MODEL || 'claude-sonnet-4-6';
// Whether to also downgrade subagent traffic to SMALL_MODEL. Off by default
// (subagents may legitimately need full reasoning capability).
const SUBAGENT_USE_SMALL_MODEL = /^1|true|yes$/i.test(process.env.SUBAGENT_USE_SMALL_MODEL || '');

// ── 配置 ──
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';  // 留空 = 不校验
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, 'token.json');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-4.5-sonnet';
const CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION || '2.6.20';

// ── Bridge / conversation caches (Anthropic tool-use flow) ──
//
// activeBridges:    bridgeKey  -> { bridge, lastAccessMs, mcpTools, pendingExecs, convKey, conversationId, requestedModel, cursorModel }
//                   pendingExecs: [{ execMsgId, execId, toolCallId, toolName, args, anthropicToolUseId, blockIndex }]
// conversationStates: convKey  -> { conversationId, state: Buffer, lastAccessMs }
const activeBridges = new Map();
const conversationStates = new Map();

const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 min

function evictStale() {
  const now = Date.now();
  for (const [k, v] of conversationStates) {
    if (now - v.lastAccessMs > CONVERSATION_TTL_MS) conversationStates.delete(k);
  }
  for (const [k, v] of activeBridges) {
    if (now - v.lastAccessMs > CONVERSATION_TTL_MS) {
      try { v.bridge.close(); } catch {}
      activeBridges.delete(k);
    }
  }
}
setInterval(evictStale, 60 * 1000).unref();

// ── 加载 Tokens ──
let tokens = [];
let roundRobinIndex = 0;

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      console.error(`  ❌ token.json not found: ${TOKEN_FILE}`);
      console.error('  📝 Create token.json with your Cursor credentials');
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    tokens = (data.tokens || []).filter(t => t.accessToken && t.accessToken !== 'your-cursor-access-token-here');
    if (tokens.length === 0) {
      console.error('  ❌ No valid tokens in token.json');
      console.error('  📝 Add at least one token with a valid accessToken');
      process.exit(1);
    }
    return tokens.length;
  } catch (e) {
    console.error(`  ❌ Failed to load token.json: ${e.message}`);
    process.exit(1);
  }
}

// 监听 token.json 变化, 自动热更新
function watchTokenFile() {
  try {
    fs.watchFile(TOKEN_FILE, { interval: 5000 }, () => {
      try {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        const newTokens = (data.tokens || []).filter(t => t.accessToken && t.accessToken !== 'your-cursor-access-token-here');
        if (newTokens.length > 0) {
          tokens = newTokens;
          roundRobinIndex = 0;
          console.log(`  🔄 token.json reloaded: ${tokens.length} token(s)`);
        }
      } catch {}
    });
  } catch {}
}

// 轮询选 token
function pickToken() {
  if (tokens.length === 0) return null;
  roundRobinIndex = roundRobinIndex % tokens.length;
  const token = tokens[roundRobinIndex];
  roundRobinIndex++;
  return {
    accessToken: token.accessToken,
    machineId: token.machineId || '',
    macMachineId: token.macMachineId || '',
  };
}

// ── Express 应用 ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── API Key 简单校验 ──
function checkApiKey(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
  const key = auth.replace(/^Bearer\s+/i, '');
  if (key !== API_KEY) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  next();
}

// ── GET /v1/models ──
app.get('/v1/models', checkApiKey, async (req, res) => {
  try {
    const token = pickToken();
    if (!token) return res.json({ object: 'list', data: [] });
    const result = await cursorClient.getModels(token);
    res.json(converter.buildModelsResponse(result.models || []));
  } catch {
    res.json({ object: 'list', data: [] });
  }
});

// ── POST /v1/chat/completions ──
app.post('/v1/chat/completions', checkApiKey, async (req, res) => {
  const { messages, model, stream } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json(converter.buildErrorResponse('messages is required', 'invalid_request_error', 400));
  }

  const token = pickToken();
  if (!token) {
    return res.status(503).json(converter.buildErrorResponse('No available tokens', 'server_error', 503));
  }

  const requestedModel = model || 'gpt-4';
  const cursorModel = converter.mapModel(requestedModel);
  const prompt = converter.messagesToPrompt(messages);
  const isStream = stream === true;

  console.log(`  📨 [${new Date().toLocaleTimeString()}] ${requestedModel} → ${cursorModel} | stream=${isStream} | ${prompt.substring(0, 80)}...`);

  if (isStream) {
    // ── 流式响应 ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(converter.buildRoleChunk(requestedModel));

    try {
      const result = await cursorClient.chat(token, prompt, cursorModel, {
        stream: true,
        onDelta: (text) => {
          if (!res.writableEnded) {
            res.write(converter.buildStreamChunk(text, requestedModel));
          }
        },
      });

      if (result.error && !res.writableEnded) {
        res.write(converter.buildStreamChunk(`\n\n[Error: ${result.error}]`, requestedModel));
      }

      if (!res.writableEnded) {
        res.write(converter.buildStreamChunk(null, requestedModel, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }

      console.log(`  ✅ stream done | in=${result.inputTokens} out=${result.outputTokens}`);
    } catch (e) {
      console.error(`  ❌ stream error: ${e.message}`);
      if (!res.writableEnded) {
        res.write(converter.buildStreamChunk(`\n\n[Error: ${e.message}]`, requestedModel));
        res.write(converter.buildStreamChunk(null, requestedModel, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }

  } else {
    // ── 非流式响应 ──
    try {
      const result = await cursorClient.chat(token, prompt, cursorModel, { stream: false });

      if (result.error) {
        console.error(`  ❌ ${result.error}`);
        return res.status(500).json(converter.buildErrorResponse(result.error));
      }

      console.log(`  ✅ done | in=${result.inputTokens} out=${result.outputTokens}`);
      res.json(converter.buildChatResponse(result.text, requestedModel, result.inputTokens, result.outputTokens));
    } catch (e) {
      console.error(`  ❌ ${e.message}`);
      res.status(500).json(converter.buildErrorResponse(e.message));
    }
  }
});

// ── SSE helper ──
function setSSEHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// ── Build the per-turn callback set used by handleFreshTurn / handleContinuation ──
//
// Captures the response stream, the per-turn state, and the cache identifiers
// so the same callback shape can drive both the initial turn and any
// re-entered turns (after sendToolResult). The returned `closeOpenBlock()` is
// also handy for the caller to invoke before terminating the response.
function buildTurnCallbacks(ctx) {
  const {
    res, isStream, turnState,
    convKey, bridgeKey, conversationId,
    requestedModel, cursorModel, mcpTools,
    getBridge, requestId,
  } = ctx;

  function closeOpenBlock() {
    if (turnState.textBlockOpen) {
      if (isStream && !res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockStop(turnState.nextBlockIndex - 1));
      }
      turnState.textBlockOpen = false;
    }
    if (turnState.thinkingBlockOpen) {
      if (isStream && !res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockStop(turnState.nextBlockIndex - 1));
      }
      turnState.thinkingBlockOpen = false;
    }
  }

  function finalizeToolUseTurn() {
    if (turnState.toolUseFinished) return;
    if (turnState.toolUseFinishTimer) {
      clearTimeout(turnState.toolUseFinishTimer);
      turnState.toolUseFinishTimer = null;
    }
    turnState.toolUseFinished = true;
    closeOpenBlock();

    // Cache the bridge for the client's follow-up tool_result POST.
    const bridge = getBridge();
    activeBridges.set(bridgeKey, {
      bridge,
      lastAccessMs: Date.now(),
      mcpTools,
      pendingExecs: turnState.pendingToolCalls.slice(),
      convKey,
      conversationId,
      requestedModel,
      cursorModel,
      requestId,
    });

    if (isStream) {
      if (!res.writableEnded) {
        res.write(anthropicConverter.buildMessageDelta('tool_use', 0));
        res.write(anthropicConverter.buildMessageStop());
        res.end();
      }
    } else if (!res.headersSent) {
      const toolUses = turnState.pendingToolCalls.map(tc => ({
        id: tc.anthropicToolUseId,
        name: tc.toolName,
        input: tc.args,
      }));
      res.json(anthropicConverter.buildAnthropicResponse(
        turnState.accumulatedText,
        requestedModel,
        0, 0,
        { stopReason: 'tool_use', toolUses }
      ));
    }

    console.log(
      `  ✅ turn ended (tool_use finalize) | toolCalls=${turnState.pendingToolCalls.length}`
    );
  }

  // Backstop debounce — fires if no `stepCompleted` arrives. The common
  // case (stepCompleted comes ~10ms after the last mcpArgs) finalizes
  // immediately via onStepCompleted; this 250ms is just a safety net.
  function armToolUseFinalizer() {
    if (turnState.toolUseFinishTimer) clearTimeout(turnState.toolUseFinishTimer);
    turnState.toolUseFinishTimer = setTimeout(finalizeToolUseTurn, 250);
  }

  return {
    closeOpenBlock,

    onTextDelta: (text) => {
      if (turnState.thinkingBlockOpen) closeOpenBlock();
      if (!turnState.textBlockOpen) {
        const idx = turnState.nextBlockIndex++;
        if (isStream && !res.writableEnded) {
          res.write(anthropicConverter.buildContentBlockStart(idx));
        }
        turnState.textBlockOpen = true;
      }
      turnState.accumulatedText += text;
      if (isStream && !res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockDelta(turnState.nextBlockIndex - 1, text));
      }
    },

    onThinkingDelta: (text) => {
      if (turnState.textBlockOpen) closeOpenBlock();
      if (!turnState.thinkingBlockOpen) {
        const idx = turnState.nextBlockIndex++;
        if (isStream && !res.writableEnded) {
          res.write(anthropicConverter.buildContentBlockStartThinking(idx));
        }
        turnState.thinkingBlockOpen = true;
      }
      turnState.accumulatedThinking += text;
      if (isStream && !res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockDeltaThinking(turnState.nextBlockIndex - 1, text));
      }
    },

    onMcpCall: ({ id, execId, toolCallId, toolName, args }) => {
      closeOpenBlock();
      const blockIndex = turnState.nextBlockIndex++;
      const anthropicToolUseId = anthropicTools.encodeToolUseId(convKey, execId, toolCallId);

      turnState.pendingToolCalls.push({
        execMsgId: id, execId, toolCallId, toolName, args,
        anthropicToolUseId, blockIndex,
      });

      if (isStream && !res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockStartToolUse(blockIndex, anthropicToolUseId, toolName));
        try {
          res.write(anthropicConverter.buildContentBlockDeltaInputJson(blockIndex, JSON.stringify(args || {})));
        } catch {
          res.write(anthropicConverter.buildContentBlockDeltaInputJson(blockIndex, '{}'));
        }
        res.write(anthropicConverter.buildContentBlockStop(blockIndex));
      }

      let argsPreview = '';
      try { argsPreview = JSON.stringify(args || {}).slice(0, 80); } catch { argsPreview = '{...}'; }
      console.log(`  🔧 tool call: ${toolName}(${argsPreview}) → ${anthropicToolUseId}`);
      debugLog.logToolCall(
        { request_id: requestId, conv_key: convKey, model_cursor: cursorModel },
        toolName, args
      );

      // The Cursor stream is now paused waiting for our mcpResult — Cursor
      // will NOT emit turnEnded until we send tool results. So we synthesize
      // a turn-end with stop_reason=tool_use either:
      //   - immediately on `stepCompleted` (the model has finished emitting
      //     tool calls for this step), or
      //   - after a 250 ms backstop debounce in case stepCompleted is
      //     delayed or missing.
      // The first signal wins; the other is no-op'd by `toolUseFinished`.
      armToolUseFinalizer();
    },

    onStepCompleted: () => {
      // Cursor finished a step; if we have pending tool calls, this is the
      // signal that the model is done emitting them and is now waiting for
      // the result. Fire the finalize immediately — saves the 250 ms debounce.
      if (turnState.pendingToolCalls.length > 0 && !turnState.toolUseFinished) {
        finalizeToolUseTurn();
      }
    },

    onTurnEnded: ({ inputTokens, outputTokens, conversationState: newState }) => {
      closeOpenBlock();

      // NOTE: we deliberately do NOT cache `newState` to conversationStates
      // anymore. Empirically, Cursor's KV blob store appears to be scoped
      // per-H2-stream — replaying a saved checkpoint on a fresh stream
      // triggers `Connect error internal: Blob not found` because the
      // referenced blobs only existed in the closed stream. Each fresh
      // /v1/messages request starts with empty state; Cursor rebuilds its
      // blob store from setBlobArgs and the client re-supplies the message
      // history anyway. The conversationStates Map is kept for the future
      // case where we share an H2 client across requests.

      // If we already finalized this turn via the tool-use debounce, ignore
      // (the model has paused waiting for tool results — turnEnded won't fire
      // until we sendToolResult, but if it does we don't want to double-send).
      if (turnState.toolUseFinished) {
        console.log(`  (turnEnded after tool_use finalize, in=${inputTokens} out=${outputTokens})`);
        return;
      }

      const hasTools = turnState.pendingToolCalls.length > 0;
      const stopReason = hasTools ? 'tool_use' : 'end_turn';

      const bridge = getBridge();

      if (hasTools) {
        activeBridges.set(bridgeKey, {
          bridge,
          lastAccessMs: Date.now(),
          mcpTools,
          pendingExecs: turnState.pendingToolCalls.slice(),
          convKey,
          conversationId,
          requestedModel,
          cursorModel,
          requestId,
        });
      } else {
        activeBridges.delete(bridgeKey);
        try { bridge && bridge.close(); } catch {}
      }

      if (isStream) {
        if (!res.writableEnded) {
          res.write(anthropicConverter.buildMessageDelta(stopReason, outputTokens || 0));
          res.write(anthropicConverter.buildMessageStop());
          res.end();
        }
      } else if (!res.headersSent) {
        const toolUses = turnState.pendingToolCalls.map(tc => ({
          id: tc.anthropicToolUseId,
          name: tc.toolName,
          input: tc.args,
        }));
        res.json(anthropicConverter.buildAnthropicResponse(
          turnState.accumulatedText,
          requestedModel,
          inputTokens,
          outputTokens,
          { stopReason, toolUses }
        ));
      }

      console.log(
        `  ✅ turn ended | in=${inputTokens} out=${outputTokens} | ` +
        `stopReason=${stopReason} | toolCalls=${turnState.pendingToolCalls.length}`
      );
      debugLog.logTurnEnded(
        { request_id: requestId, conv_key: convKey, model_cursor: cursorModel },
        { inputTokens, outputTokens },
        stopReason, turnState.pendingToolCalls.length
      );
    },


    onError: (errMsg) => {
      console.error(`  ❌ ${errMsg}`);
      activeBridges.delete(bridgeKey);

      debugLog.logCursorError({
        request_id: requestId,
        conv_key: convKey,
        bridge_key: bridgeKey,
        model_requested: requestedModel,
        model_cursor: cursorModel,
        is_stream: isStream,
        accumulated_text_len: (turnState.accumulatedText || '').length,
        accumulated_thinking_len: (turnState.accumulatedThinking || '').length,
        pending_tool_calls: turnState.pendingToolCalls.length,
        next_block_index: turnState.nextBlockIndex,
      }, errMsg);

      // "Blob not found" means our cached conversationState references blobs
      // Cursor's KV store has evicted. The state is no longer usable — drop
      // it so the NEXT request from this client re-derives a fresh context
      // instead of hitting the same error again.
      if (/blob not found/i.test(errMsg)) {
        conversationStates.delete(convKey);
        if (process.env.CURSOR_AGENT_DEBUG) {
          console.log(`  ↩️  evicted stale conversationState for convKey=${convKey} (blob expired upstream)`);
        }
      }

      const bridge = getBridge();
      try { bridge && bridge.close(); } catch {}

      if (isStream) {
        if (!res.writableEnded) {
          closeOpenBlock();
          const idx = turnState.nextBlockIndex++;
          res.write(anthropicConverter.buildContentBlockStart(idx));
          res.write(anthropicConverter.buildContentBlockDelta(idx, `\n\n[Error: ${errMsg}]`));
          res.write(anthropicConverter.buildContentBlockStop(idx));
          res.write(anthropicConverter.buildMessageDelta('end_turn', 0));
          res.write(anthropicConverter.buildMessageStop());
          res.end();
        }
      } else if (!res.headersSent) {
        res.status(500).json(anthropicConverter.buildAnthropicErrorResponse(errMsg, 'api_error'));
      }
    },
  };
}

function makeTurnState() {
  return {
    textBlockOpen: false,
    thinkingBlockOpen: false,
    nextBlockIndex: 0,
    pendingToolCalls: [],   // { execMsgId, execId, toolCallId, toolName, args, anthropicToolUseId, blockIndex }
    accumulatedText: '',
    accumulatedThinking: '',
  };
}

// ── Path A: Resume the cached bridge with tool results ──
async function handleContinuation(req, res, cached, messages, requestedModel, cursorModel, isStream, bridgeKey) {
  const toolResults = anthropicTools.extractToolResults(messages);

  if (toolResults.length === 0) {
    return res.status(400).json(
      anthropicConverter.buildAnthropicErrorResponse('Continuation request has no tool_result blocks', 'invalid_request_error')
    );
  }

  console.log(`  🔄 continuation | toolResults=${toolResults.length} | pendingExecs=${cached.pendingExecs.length}`);

  if (isStream) {
    setSSEHeaders(res);
    res.write(anthropicConverter.buildMessageStart(requestedModel, 0));
    res.write(anthropicConverter.buildPing());
  }

  const turnState = makeTurnState();

  const callbacks = buildTurnCallbacks({
    res, isStream, turnState,
    convKey: cached.convKey,
    // Use the EXACT bridgeKey the caller computed (with system + remoteAddr
    // already mixed in) so re-caching after another tool round-trip matches
    // the original entry.
    bridgeKey,
    conversationId: cached.conversationId,
    requestedModel, cursorModel,
    mcpTools: cached.mcpTools,
    getBridge: () => cached.bridge,
    requestId: cached.requestId,
  });

  // Re-bind bridge callbacks so events from this resumed turn drive the
  // new HTTP response, not the closed one from the previous request.
  cached.bridge.setCallbacks({
    onTextDelta: callbacks.onTextDelta,
    onThinkingDelta: callbacks.onThinkingDelta,
    onMcpCall: callbacks.onMcpCall,
    onStepCompleted: callbacks.onStepCompleted,
    onTurnEnded: callbacks.onTurnEnded,
    onError: callbacks.onError,
  });

  // Build a quick lookup for tool_use_id → result and feed each pending exec.
  const resultById = new Map();
  for (const r of toolResults) resultById.set(r.toolUseId, r);

  for (const exec of cached.pendingExecs) {
    const matching = resultById.get(exec.anthropicToolUseId);
    let payload;
    if (matching) {
      if (matching.isError) {
        payload = { error: matching.content || 'Tool execution failed' };
      } else if (Array.isArray(matching.contentItems) && matching.contentItems.length > 0) {
        // Pass the structured items so image blocks survive the round-trip
        // (otherwise screenshots/PNG content from Read or Bash get dropped).
        payload = { items: matching.contentItems };
      } else {
        payload = matching.content;
      }
    } else {
      payload = { error: 'Tool result not provided by client' };
    }
    cached.bridge.sendToolResult(exec.execMsgId, exec.execId, payload);
  }

  // Clear the cached pending list — the new turn may add more.
  cached.pendingExecs = [];
  cached.lastAccessMs = Date.now();

  // Cleanup if the caller bails before turnEnded.
  req.on('close', () => {
    if (res.writableEnded) return;
    // Don't close the bridge on disconnect — the model may still be running
    // and the next request will re-bind callbacks. Eviction will reap it.
  });
}

// ── Path B: Open a fresh Cursor conversation ──
async function handleFreshTurn(req, res, token, params) {
  const {
    messages, system, requestedModel, cursorModel, isStream,
    convKey, bridgeKey, conversationId, tools,
  } = params;

  const prompt = anthropicConverter.anthropicMessagesToPrompt(messages, system);
  const mcpTools = anthropicTools.anthropicToolsToMcpTools(tools, 'cursoride2api');

  // Do NOT load cached state — see onTurnEnded note. Cursor's blob store is
  // per-H2-stream and replaying a stale checkpoint triggers Blob not found.
  const conversationState = null;

  if (isStream) {
    setSSEHeaders(res);
    res.write(anthropicConverter.buildMessageStart(requestedModel, 0));
    res.write(anthropicConverter.buildPing());
  }

  const turnState = makeTurnState();

  // Forward declaration — `bridge` is assigned below but the callbacks need
  // a stable getter so `getBridge()` returns the right object.
  let bridge = null;
  const callbacks = buildTurnCallbacks({
    res, isStream, turnState,
    convKey, bridgeKey, conversationId,
    requestedModel, cursorModel, mcpTools,
    getBridge: () => bridge,
    requestId: params.requestId,
  });

  bridge = cursorAgent.startConversation(token, {
    prompt,
    modelId: cursorModel,
    conversationId,
    conversationState,
    tools: mcpTools,
    onTextDelta: callbacks.onTextDelta,
    onThinkingDelta: callbacks.onThinkingDelta,
    onMcpCall: callbacks.onMcpCall,
    onStepCompleted: callbacks.onStepCompleted,
    onTurnEnded: callbacks.onTurnEnded,
    onError: callbacks.onError,
  });

  // NOTE: We intentionally do NOT register req.on('close') here. In some Node
  // versions the 'close' event on the incoming request can fire as soon as the
  // body has been fully consumed by express.json(), which would close our
  // outgoing H2 stream prematurely and kill the in-flight Cursor request.
  // The TTL eviction loop is responsible for reaping stale bridges.
}

// ── POST /v1/messages (Anthropic Messages API, full tool-use) ──
app.post('/v1/messages', checkApiKey, async (req, res) => {
  const body = req.body || {};
  const { messages, model, system, max_tokens, stream, temperature, top_p, stop_sequences, tools } = body;

  // Optional debug dump
  if (process.env.DUMP_REQUESTS) {
    try {
      const dumpFile = `/tmp/v1messages-${Date.now()}-${Math.random().toString(36).slice(2,6)}.json`;
      require('fs').writeFileSync(dumpFile, JSON.stringify(body, null, 2));
      console.log(`  📋 dumped request to ${dumpFile} | bytes=${JSON.stringify(body).length} | tools=${(tools||[]).length} | msgs=${(messages||[]).length}`);
    } catch (e) { /* ignore */ }
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    debugLog.warn('rejected_request', {
      reason: 'messages is required',
      method: req.method, path: req.path, remote: req.ip,
      body_keys: Object.keys(body),
    });
    return res.status(400).json(anthropicConverter.buildAnthropicErrorResponse('messages is required', 'invalid_request_error'));
  }

  const token = pickToken();
  if (!token) {
    debugLog.error('no_tokens_available', {
      reason: 'No available tokens',
      method: req.method, path: req.path,
    });
    return res.status(503).json(anthropicConverter.buildAnthropicErrorResponse('No available tokens', 'api_error'));
  }

  const requestedModel = model || 'claude-sonnet-4-6';

  // Run all preprocessing (compaction detect, subagent marker, IDE-tool
  // sanitize) in one pass so server.js only sees a single decision object.
  const pre = preprocess.preprocessAnthropicRequest(body);

  // Cursor has no Claude Haiku model. We previously routed warmup pings to
  // `composer-2-fast` (Cursor's own Kimi-K2.5 Composer 2, not Claude). All
  // claude-haiku-* requests now upgrade to a real Claude — adjustable via
  // SMALL_MODEL env var.
  let effectiveModel = requestedModel;
  let routingReason = null;
  if (/^claude-haiku/i.test(requestedModel)) {
    effectiveModel = SMALL_MODEL;
    routingReason = 'haiku-upgrade';
  }
  // Compaction calls (Claude Code's /compact, OpenCode's anchor summarizer)
  // don't need full Sonnet/Opus. Route to small model and log.
  if (pre.compactType === preprocess.COMPACT_REQUEST) {
    effectiveModel = SMALL_MODEL;
    routingReason = 'compact-request';
  } else if (pre.compactType === preprocess.COMPACT_AUTO_CONTINUE) {
    // Auto-continue happens AFTER a compact summary lands; the model is
    // re-attaching to the truncated history. Real model semantics matter
    // here (it has to keep coding), so we leave the model as-is but mark it.
    routingReason = 'compact-auto-continue';
  }
  // Subagent traffic — opt-in downgrade.
  if (pre.subagentMarker) {
    if (SUBAGENT_USE_SMALL_MODEL) {
      effectiveModel = SMALL_MODEL;
      routingReason = `subagent (${pre.subagentMarker.agent_type})`;
    } else if (!routingReason) {
      routingReason = `subagent passthrough (${pre.subagentMarker.agent_type})`;
    }
  }
  const cursorModel = anthropicConverter.mapAnthropicModel(effectiveModel, config.anthropicModelMapping);
  const isStream = stream === true;

  // Salt the cache keys with the client's remote address + remote port + tool
  // list hash. Two concurrent sessions that happen to send the same
  // first-user-text would otherwise collide on the bridge cache and clobber
  // each other's H2 streams (the second's `continuation=false` overwrites the
  // first's bridge entry; the first then routes its tool_result onto the
  // wrong stream and hangs). `remotePort` is the cheapest distinguisher: a
  // claude-code process keeps a single keep-alive socket, so within a session
  // the port is stable; two concurrent processes get distinct ports.
  const remoteAddr = (req.ip || req.socket?.remoteAddress || '').toString();
  const remotePort = req.socket?.remotePort;
  const convKey = anthropicTools.deriveConversationKey(messages, cursorModel, system, tools, remoteAddr, remotePort);
  const bridgeKey = anthropicTools.deriveBridgeKey(cursorModel, messages, system, tools, remoteAddr, remotePort);
  const conversationId = anthropicTools.deterministicConversationId(convKey);

  const isContinuation = anthropicTools.hasToolResults(messages);

  const requestId = uuidv4().slice(0, 8);
  const reasonLabel = routingReason ? ` | ${routingReason}` : '';
  console.log(
    `  📨 [${new Date().toLocaleTimeString()}] (Anthropic) ${requestedModel} → ${cursorModel} | ` +
    `stream=${isStream} | continuation=${isContinuation} | convKey=${convKey} | reqId=${requestId}${reasonLabel}`
  );

  debugLog.logRequest(req, body, {
    requestId,
    requestedModel, effectiveModel, cursorModel,
    convKey, bridgeKey, isContinuation,
    compactType: pre.compactType,
    subagentMarker: pre.subagentMarker,
    routingReason,
  });

  // Path A: continuation — caller is delivering tool_result blocks.
  if (isContinuation) {
    const cached = activeBridges.get(bridgeKey);
    if (cached) {
      cached.lastAccessMs = Date.now();
      cached.requestId = requestId;
      return handleContinuation(req, res, cached, messages, requestedModel, cursorModel, isStream, bridgeKey);
    }
    // Cache miss — bridge died or was evicted. Fall through to a fresh turn
    // using the full message history (system + alternations) as the prompt.
    console.log('  ⚠️  Bridge cache miss for continuation; starting fresh');
    debugLog.warn('continuation_cache_miss', { request_id: requestId, conv_key: convKey, bridge_key: bridgeKey });
  }

  // Path B: fresh turn.
  return handleFreshTurn(req, res, token, {
    messages, system, requestedModel, cursorModel, isStream,
    convKey, bridgeKey, conversationId, tools, requestId,
  });
});

// ── POST /v1/messages/count_tokens (Anthropic Messages API) ──
//
// Claude Code calls this to plan things like whether a /btw fork can fit
// in the context window. Without it the call 404s and Claude Code can
// silently abort the operation. Anthropic's real endpoint returns
//   { "input_tokens": <int> }
// We approximate by character-count heuristic (~3.5 chars per token for
// Claude). Good enough for fit-check purposes; not for billing.
function _countCharsRecursive(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number') return String(value).length;
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += _countCharsRecursive(item);
    return n;
  }
  if (typeof value === 'object') {
    let n = 0;
    for (const k of Object.keys(value)) {
      // Field-name overhead matters slightly — count it
      n += k.length;
      n += _countCharsRecursive(value[k]);
    }
    return n;
  }
  return 0;
}

app.post('/v1/messages/count_tokens', checkApiKey, async (req, res) => {
  const body = req.body || {};
  const { messages, system, tools } = body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json(anthropicConverter.buildAnthropicErrorResponse(
      'messages is required', 'invalid_request_error'
    ));
  }

  // Sum chars across system, messages, tools.
  let chars = 0;
  if (system != null) chars += _countCharsRecursive(system);
  chars += _countCharsRecursive(messages);
  if (Array.isArray(tools)) chars += _countCharsRecursive(tools);

  // ~3.5 chars per token for Claude is a decent estimate for English code/text.
  // Round up so we never under-report (which could cause Claude Code to
  // think a fork fits when it doesn't).
  const inputTokens = Math.ceil(chars / 3.5);

  if (debugLog.isEnabled()) {
    debugLog.info('count_tokens', {
      msg_count: messages.length,
      tool_count: Array.isArray(tools) ? tools.length : 0,
      has_system: system != null,
      chars,
      input_tokens: inputTokens,
    });
  }

  res.json({ input_tokens: inputTokens });
});

// ── 健康检查 ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tokens: tokens.length,
    defaultModel: DEFAULT_MODEL,
    version: '2.0.0',
  });
});

// ── 启动 ──
const count = loadTokens();
watchTokenFile();

// Pre-warm the shared H2 client + proto schemas so the first /v1/messages
// request doesn't pay the TLS handshake / proto load latency.
cursorAgent.prewarmSharedClient();

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║       CursorIDE2API v2.0 (Lite)           ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  🌐 http://${HOST}:${PORT}                     ║`);
  console.log(`  ║  🔌 /v1/chat/completions                  ║`);
  console.log(`  ║  🔌 /v1/messages (Anthropic)               ║`);
  console.log(`  ║  🔌 /v1/messages/count_tokens             ║`);
  console.log(`  ║  📋 /v1/models                            ║`);
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  🔑 Tokens: ${String(count).padEnd(30)}║`);
  console.log(`  ║  🤖 Default: ${DEFAULT_MODEL.padEnd(29)}║`);
  console.log(`  ║  🔐 API Key: ${(API_KEY ? 'SET' : 'OPEN (no key)').padEnd(29)}║`);
  if (debugLog.isEnabled()) {
    console.log(`  ║  📝 Debug: ${(debugLog.isVerbose() ? 'verbose' : 'on').padEnd(31)}║`);
  }
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
});

// ── 优雅退出 ──
process.on('SIGINT', () => { console.log('\n  Bye!'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
