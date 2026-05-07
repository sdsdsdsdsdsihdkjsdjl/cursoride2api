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

// ── 配置 ──
const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';  // 留空 = 不校验
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, 'token.json');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-4.5-sonnet';
const CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION || '2.6.20';

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

// ── POST /v1/messages (Anthropic Messages API) ──
app.post('/v1/messages', checkApiKey, async (req, res) => {
  const { messages, model, system, max_tokens, stream, temperature, top_p, stop_sequences } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json(anthropicConverter.buildAnthropicErrorResponse('messages is required', 'invalid_request_error'));
  }

  const token = pickToken();
  if (!token) {
    return res.status(503).json(anthropicConverter.buildAnthropicErrorResponse('No available tokens', 'api_error'));
  }

  const requestedModel = model || 'claude-sonnet-4-20250514';
  const cursorModel = anthropicConverter.mapAnthropicModel(requestedModel, config.anthropicModelMapping);
  const prompt = anthropicConverter.anthropicMessagesToPrompt(messages, system);
  const isStream = stream === true;

  console.log(`  📨 [${new Date().toLocaleTimeString()}] (Anthropic) ${requestedModel} → ${cursorModel} | stream=${isStream} | ${prompt.substring(0, 80)}...`);

  if (isStream) {
    // ── Anthropic 流式响应 ──
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(anthropicConverter.buildMessageStart(requestedModel, 0));
    res.write(anthropicConverter.buildPing());
    res.write(anthropicConverter.buildContentBlockStart(0));

    try {
      const result = await cursorClient.chat(token, prompt, cursorModel, {
        stream: true,
        onDelta: (text) => {
          if (!res.writableEnded) {
            res.write(anthropicConverter.buildContentBlockDelta(0, text));
          }
        },
      });

      if (result.error && !res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockDelta(0, `\n\n[Error: ${result.error}]`));
      }

      if (!res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockStop(0));
        res.write(anthropicConverter.buildMessageDelta('end_turn', result.outputTokens || 0));
        res.write(anthropicConverter.buildMessageStop());
        res.end();
      }

      console.log(`  ✅ anthropic stream done | in=${result.inputTokens} out=${result.outputTokens}`);
    } catch (e) {
      console.error(`  ❌ anthropic stream error: ${e.message}`);
      if (!res.writableEnded) {
        res.write(anthropicConverter.buildContentBlockDelta(0, `\n\n[Error: ${e.message}]`));
        res.write(anthropicConverter.buildContentBlockStop(0));
        res.write(anthropicConverter.buildMessageDelta('end_turn', 0));
        res.write(anthropicConverter.buildMessageStop());
        res.end();
      }
    }

  } else {
    // ── Anthropic 非流式响应 ──
    try {
      const result = await cursorClient.chat(token, prompt, cursorModel, { stream: false });

      if (result.error) {
        console.error(`  ❌ ${result.error}`);
        return res.status(500).json(anthropicConverter.buildAnthropicErrorResponse(result.error, 'api_error'));
      }

      console.log(`  ✅ anthropic done | in=${result.inputTokens} out=${result.outputTokens}`);
      res.json(anthropicConverter.buildAnthropicResponse(result.text, requestedModel, result.inputTokens, result.outputTokens));
    } catch (e) {
      console.error(`  ❌ ${e.message}`);
      res.status(500).json(anthropicConverter.buildAnthropicErrorResponse(e.message, 'api_error'));
    }
  }
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
