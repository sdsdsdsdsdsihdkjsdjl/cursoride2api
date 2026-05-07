// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic ↔ Cursor 格式转换
// ═══════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');

/**
 * Anthropic messages → Cursor 单一 prompt
 * 将 Anthropic 格式的 messages + system 拼接为 Cursor 需要的单一文本
 */
function anthropicMessagesToPrompt(messages, system) {
  if (!messages || messages.length === 0) return '';

  const parts = [];

  // 处理 system prompt
  if (system) {
    let systemText = '';
    if (typeof system === 'string') {
      systemText = system;
    } else if (Array.isArray(system)) {
      systemText = system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    if (systemText) {
      parts.push(`<system>\n${systemText}\n</system>`);
    }
  }

  // 处理 messages
  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = '';

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const segments = [];
      for (const b of msg.content) {
        if (!b || !b.type) continue;
        if (b.type === 'text') {
          if (b.text) segments.push(b.text);
        } else if (b.type === 'tool_use') {
          let argStr = '';
          try {
            argStr = JSON.stringify(b.input || {});
          } catch (_) {
            argStr = '{}';
          }
          segments.push(`[Tool call: ${b.name || ''}(${argStr})]`);
        } else if (b.type === 'tool_result') {
          let resultText = '';
          if (typeof b.content === 'string') {
            resultText = b.content;
          } else if (Array.isArray(b.content)) {
            resultText = b.content
              .filter(c => c && c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
          segments.push(`[Tool result for ${b.tool_use_id || ''}]:\n${resultText}`);
        } else if (b.type === 'image') {
          segments.push('[image]');
        }
      }
      content = segments.join('\n');
    }

    if (!content) continue;

    if (role === 'assistant') {
      parts.push(`<assistant>\n${content}\n</assistant>`);
    } else {
      parts.push(content);
    }
  }

  return parts.join('\n\n');
}

/**
 * 映射模型名称: Anthropic → Cursor
 */
function mapAnthropicModel(model, configMapping) {
  if (!model) return null;

  if (configMapping) {
    const mapped = configMapping[model];
    if (mapped) return mapped;
  }

  // 直通 (未知模型原样传递)
  return model;
}

/**
 * 构建非流式 Anthropic 响应
 *
 * options:
 *   - stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn'
 *   - toolUses: [{ id, name, input }, ...]
 */
function buildAnthropicResponse(text, model, inputTokens, outputTokens, options = {}) {
  const { stopReason = 'end_turn', toolUses = [] } = options;

  const content = [];
  if (text) {
    content.push({ type: 'text', text: text });
  }
  for (const tu of toolUses) {
    content.push({
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input,
    });
  }

  return {
    id: `msg_${uuidv4()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
    },
  };
}

/**
 * 构建 Anthropic 错误响应
 */
function buildAnthropicErrorResponse(message, type = 'api_error', statusCode = 500) {
  return {
    type: 'error',
    error: {
      type: type,
      message: message,
    },
  };
}

// ─── SSE 流式辅助 ───────────────────────────────

/**
 * 格式化 Anthropic SSE 事件
 * Anthropic 格式: event: <type>\ndata: <json>\n\n
 */
function formatSSE(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * message_start 事件
 */
function buildMessageStart(model, inputTokens) {
  return formatSSE('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
      },
    },
  });
}

/**
 * content_block_start 事件
 */
function buildContentBlockStart(index) {
  return formatSSE('content_block_start', {
    type: 'content_block_start',
    index: index,
    content_block: { type: 'text', text: '' },
  });
}

/**
 * content_block_delta 事件
 */
function buildContentBlockDelta(index, text) {
  return formatSSE('content_block_delta', {
    type: 'content_block_delta',
    index: index,
    delta: { type: 'text_delta', text: text },
  });
}

/**
 * content_block_start 事件 (tool_use)
 */
function buildContentBlockStartToolUse(index, toolUseId, toolName) {
  return formatSSE('content_block_start', {
    type: 'content_block_start',
    index: index,
    content_block: {
      type: 'tool_use',
      id: toolUseId,
      name: toolName,
      input: {},
    },
  });
}

/**
 * content_block_delta 事件 (tool_use input — 增量 JSON)
 */
function buildContentBlockDeltaInputJson(index, partialJson) {
  return formatSSE('content_block_delta', {
    type: 'content_block_delta',
    index: index,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson,
    },
  });
}

/**
 * content_block_start 事件 (thinking)
 */
function buildContentBlockStartThinking(index) {
  return formatSSE('content_block_start', {
    type: 'content_block_start',
    index: index,
    content_block: { type: 'thinking', thinking: '' },
  });
}

/**
 * content_block_delta 事件 (thinking)
 */
function buildContentBlockDeltaThinking(index, text) {
  return formatSSE('content_block_delta', {
    type: 'content_block_delta',
    index: index,
    delta: { type: 'thinking_delta', thinking: text },
  });
}

/**
 * content_block_stop 事件
 */
function buildContentBlockStop(index) {
  return formatSSE('content_block_stop', {
    type: 'content_block_stop',
    index: index,
  });
}

/**
 * message_delta 事件
 */
function buildMessageDelta(stopReason, outputTokens) {
  return formatSSE('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason || 'end_turn',
      stop_sequence: null,
    },
    usage: {
      output_tokens: outputTokens || 0,
    },
  });
}

/**
 * message_stop 事件
 */
function buildMessageStop() {
  return formatSSE('message_stop', {
    type: 'message_stop',
  });
}

/**
 * ping 事件
 */
function buildPing() {
  return formatSSE('ping', {
    type: 'ping',
  });
}

module.exports = {
  anthropicMessagesToPrompt, mapAnthropicModel,
  buildAnthropicResponse, buildAnthropicErrorResponse,
  formatSSE,
  buildMessageStart, buildContentBlockStart, buildContentBlockDelta,
  buildContentBlockStartToolUse, buildContentBlockDeltaInputJson,
  buildContentBlockStartThinking, buildContentBlockDeltaThinking,
  buildContentBlockStop, buildMessageDelta, buildMessageStop, buildPing,
};
