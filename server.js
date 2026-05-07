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
    getBridge,
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
        // Emit args as a single input_json_delta with the full payload.
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
    },

    onTurnEnded: ({ inputTokens, outputTokens, conversationState: newState }) => {
      closeOpenBlock();

      const hasTools = turnState.pendingToolCalls.length > 0;
      const stopReason = hasTools ? 'tool_use' : 'end_turn';

      // Persist the (possibly updated) checkpoint state.
      if (newState) {
        conversationStates.set(convKey, {
          conversationId,
          state: newState,
          lastAccessMs: Date.now(),
        });
      }

      const bridge = getBridge();

      if (hasTools) {
        // Cache the bridge so the client's follow-up POST (with tool_result
        // blocks) can resume on the same H2 stream.
        activeBridges.set(bridgeKey, {
          bridge,
          lastAccessMs: Date.now(),
          mcpTools,
          pendingExecs: turnState.pendingToolCalls.slice(),
          convKey,
          conversationId,
          requestedModel,
          cursorModel,
        });
        // DO NOT close the bridge — leave it alive for the continuation.
      } else {
        // No tools → we're done. Drop the bridge cache entry and close.
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
    },

    onError: (errMsg) => {
      console.error(`  ❌ ${errMsg}`);
      activeBridges.delete(bridgeKey);
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
async function handleContinuation(req, res, cached, messages, requestedModel, cursorModel, isStream) {
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
    bridgeKey: anthropicTools.deriveBridgeKey(cursorModel, messages),
    conversationId: cached.conversationId,
    requestedModel, cursorModel,
    mcpTools: cached.mcpTools,
    getBridge: () => cached.bridge,
  });

  // Re-bind bridge callbacks so events from this resumed turn drive the
  // new HTTP response, not the closed one from the previous request.
  cached.bridge.setCallbacks({
    onTextDelta: callbacks.onTextDelta,
    onThinkingDelta: callbacks.onThinkingDelta,
    onMcpCall: callbacks.onMcpCall,
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

  const stateEntry = conversationStates.get(convKey);
  const conversationState = stateEntry ? stateEntry.state : null;

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

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json(anthropicConverter.buildAnthropicErrorResponse('messages is required', 'invalid_request_error'));
  }

  const token = pickToken();
  if (!token) {
    return res.status(503).json(anthropicConverter.buildAnthropicErrorResponse('No available tokens', 'api_error'));
  }

  const requestedModel = model || 'claude-sonnet-4-6';
  const cursorModel = anthropicConverter.mapAnthropicModel(requestedModel, config.anthropicModelMapping);
  const isStream = stream === true;

  const convKey = anthropicTools.deriveConversationKey(messages);
  const bridgeKey = anthropicTools.deriveBridgeKey(cursorModel, messages);
  const conversationId = anthropicTools.deterministicConversationId(convKey);

  const isContinuation = anthropicTools.hasToolResults(messages);

  console.log(
    `  📨 [${new Date().toLocaleTimeString()}] (Anthropic) ${requestedModel} → ${cursorModel} | ` +
    `stream=${isStream} | continuation=${isContinuation} | convKey=${convKey}`
  );

  // Path A: continuation — caller is delivering tool_result blocks.
  if (isContinuation) {
    const cached = activeBridges.get(bridgeKey);
    if (cached) {
      cached.lastAccessMs = Date.now();
      return handleContinuation(req, res, cached, messages, requestedModel, cursorModel, isStream);
    }
    // Cache miss — bridge died or was evicted. Fall through to a fresh turn
    // using the full message history (system + alternations) as the prompt.
    console.log('  ⚠️  Bridge cache miss for continuation; starting fresh');
  }

  // Path B: fresh turn.
  return handleFreshTurn(req, res, token, {
    messages, system, requestedModel, cursorModel, isStream,
    convKey, bridgeKey, conversationId, tools,
  });
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

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║       CursorIDE2API v2.0 (Lite)           ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  🌐 http://${HOST}:${PORT}                     ║`);
  console.log(`  ║  🔌 /v1/chat/completions                  ║`);
  console.log(`  ║  🔌 /v1/messages (Anthropic)               ║`);
  console.log(`  ║  📋 /v1/models                            ║`);
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  🔑 Tokens: ${String(count).padEnd(30)}║`);
  console.log(`  ║  🤖 Default: ${DEFAULT_MODEL.padEnd(29)}║`);
  console.log(`  ║  🔐 API Key: ${(API_KEY ? 'SET' : 'OPEN (no key)').padEnd(29)}║`);
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
});

// ── 优雅退出 ──
process.on('SIGINT', () => { console.log('\n  Bye!'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
