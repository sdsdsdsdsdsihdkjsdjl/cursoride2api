// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic ↔ MCP Tools 转换
// ═══════════════════════════════════════════════

const crypto = require('crypto');

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
      };

      out.push({
        toolUseId,
        conversationKey: decoded.conversationKey,
        execId: decoded.execId,
        toolCallId: decoded.toolCallId,
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
 * 对话级稳定哈希（基于 model + 首条 user 文本）
 *
 * Including modelId is important: Cursor's KV blob store is per-conversation-id
 * and the conversationId we derive is model-independent only by convention.
 * Different models reference different blob hashes, so reusing the same
 * conversationId across model switches triggers "Blob not found" errors when
 * the second model tries to load the first model's state. Keying on model
 * keeps each model's conversation state isolated.
 */
function deriveConversationKey(messages, modelId) {
  const first = extractFirstUserText(messages).slice(0, 200);
  return crypto
    .createHash('sha256')
    .update('conv:' + (modelId || '') + ':' + first)
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
