// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic ↔ MCP Tools 转换
// ═══════════════════════════════════════════════

const crypto = require('crypto');
const { encodeValue } = require('./cursor-agent');

/**
 * Anthropic tool definitions → Cursor MCP tool definitions
 * 过滤无效工具，base64 编码 inputSchema (protobuf Value bytes)
 */
function anthropicToolsToMcpTools(tools, providerIdentifier) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return [];

  const provider = providerIdentifier || 'cursoride2api';
  const out = [];

  for (const tool of tools) {
    if (!tool || !tool.name) continue;

    const schema = tool.input_schema || { type: 'object', properties: {}, required: [] };
    let inputSchemaB64;
    try {
      const bytes = encodeValue(schema);
      inputSchemaB64 = bytes.toString('base64');
    } catch (e) {
      // 跳过无法编码的工具
      continue;
    }

    out.push({
      name: tool.name,
      toolName: tool.name,
      description: tool.description || '',
      providerIdentifier: provider,
      inputSchema: inputSchemaB64,
    });
  }

  return out;
}

/**
 * 生成可逆的 tool_use_id
 * 把 conversationKey/execId/toolCallId 打包成 base64url，便于后续解析
 * 格式: toolu_<base64url(JSON)>
 */
function encodeToolUseId(conversationKey, execId, toolCallId) {
  const payload = JSON.stringify({
    ck: String(conversationKey || ''),
    ei: String(execId || ''),
    tc: String(toolCallId || ''),
  });
  const packed = Buffer.from(payload, 'utf8').toString('base64url');
  return `toolu_${packed}`;
}

/**
 * 解析 tool_use_id → { conversationKey, execId, toolCallId }
 * 解析失败返回 null
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
    };
  } catch (e) {
    return null;
  }
}

/**
 * 把 tool_result content 标准化为字符串
 */
function stringifyToolResultContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  // 兜底：对象/其他类型直接 JSON 序列化
  try {
    return JSON.stringify(content);
  } catch (e) {
    return String(content);
  }
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
      };

      out.push({
        toolUseId,
        conversationKey: decoded.conversationKey,
        execId: decoded.execId,
        toolCallId: decoded.toolCallId,
        content: stringifyToolResultContent(block.content),
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
 * 对话级稳定哈希（基于首条 user 文本）
 */
function deriveConversationKey(messages) {
  const first = extractFirstUserText(messages).slice(0, 200);
  return crypto
    .createHash('sha256')
    .update('conv:' + first)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 桥接级稳定哈希（按 model + 首条 user 文本）
 */
function deriveBridgeKey(modelId, messages) {
  const first = extractFirstUserText(messages).slice(0, 200);
  return crypto
    .createHash('sha256')
    .update('bridge:' + (modelId || '') + ':' + first)
    .digest('hex')
    .slice(0, 16);
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

module.exports = {
  anthropicToolsToMcpTools,
  encodeToolUseId, decodeToolUseId,
  extractToolResults, extractTools,
  findLatestUserMessage, extractFirstUserText,
  deriveConversationKey, deriveBridgeKey,
  deterministicConversationId,
  hasToolResults,
};
