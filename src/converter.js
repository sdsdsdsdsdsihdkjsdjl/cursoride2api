// ═══════════════════════════════════════════════
//  CursorIDE2API - OpenAI ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const config = require('./config');
const { v4: uuidv4 } = require('uuid');

/**
 * OpenAI messages → Cursor 单一 prompt
 * Cursor Agent 只接受单个 text，我们需要拼接所有消息
 */
function messagesToPrompt(messages) {
  if (!messages || messages.length === 0) return '';

  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Vision/multi-part content
      content = msg.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }

    if (!content) continue;

    if (role === 'system') {
      parts.push(`<system>\n${content}\n</system>`);
    } else if (role === 'assistant') {
      parts.push(`<assistant>\n${content}\n</assistant>`);
    } else {
      parts.push(content);
    }
  }

  return parts.join('\n\n');
}

/**
 * 映射模型名称: OpenAI → Cursor
 */
function mapModel(model) {
  if (!model) return config.cursor.defaultModel;

  // 先查映射表
  const mapped = config.modelMapping[model];
  if (mapped) return mapped;

  // 直通 (假设用户直接传了 Cursor 模型名)
  return model;
}

/**
 * 构建非流式 OpenAI 响应
 */
function buildChatResponse(text, model, inputTokens, outputTokens) {
  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: inputTokens || 0,
      completion_tokens: outputTokens || 0,
      total_tokens: (inputTokens || 0) + (outputTokens || 0),
    },
  };
}

/**
 * Mint a fresh stream identity (id + created timestamp). OpenAI clients
 * expect the same `chatcmpl-<id>` and `created` to repeat across every
 * chunk in a single completion stream. Call this once per request and
 * pass the result into buildStreamChunk / buildRoleChunk.
 */
function newStreamIdentity() {
  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    created: Math.floor(Date.now() / 1000),
  };
}

/**
 * 构建流式 SSE chunk. `identity` should be the value returned by
 * newStreamIdentity() at the start of the request — falls back to a
 * fresh identity for callers that haven't migrated yet.
 */
function buildStreamChunk(delta, model, finishReason = null, identity = null) {
  const ident = identity || newStreamIdentity();
  const chunk = {
    id: ident.id,
    object: 'chat.completion.chunk',
    created: ident.created,
    model: model,
    choices: [{
      index: 0,
      delta: delta ? { content: delta } : {},
      finish_reason: finishReason,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 构建流式角色 chunk (第一条)
 */
function buildRoleChunk(model, identity = null) {
  const ident = identity || newStreamIdentity();
  const chunk = {
    id: ident.id,
    object: 'chat.completion.chunk',
    created: ident.created,
    model: model,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * 构建错误响应
 */
function buildErrorResponse(message, type = 'server_error', code = 500) {
  return {
    error: {
      message: message,
      type: type,
      param: null,
      code: code,
    },
  };
}

/**
 * 构建模型列表响应
 */
function buildModelsResponse(cursorModels = []) {
  const models = cursorModels.map(m => ({
    id: m.modelId || m.model_id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cursor',
    permission: [],
    root: m.modelId || m.model_id,
    parent: null,
  }));

  return {
    object: 'list',
    data: models,
  };
}

module.exports = {
  messagesToPrompt, mapModel,
  buildChatResponse, buildStreamChunk, buildRoleChunk,
  buildErrorResponse, buildModelsResponse,
  newStreamIdentity,
};
