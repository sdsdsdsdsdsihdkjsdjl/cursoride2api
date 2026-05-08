// ═══════════════════════════════════════════════
//  CursorIDE2API v2 - 简化配置
// ═══════════════════════════════════════════════

const config = {
  cursor: {
    baseUrl: 'https://api2.cursor.sh',
    clientVersion: process.env.CURSOR_CLIENT_VERSION || '2.6.20',
    defaultModel: process.env.DEFAULT_MODEL || 'claude-4.5-sonnet',
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '120000'),
    heartbeatInterval: 5000,
  },

  // 模型映射 (OpenAI model → Cursor model)
  modelMapping: {
    'gpt-4': 'composer-2',
    'gpt-4o': 'composer-2',
    'gpt-4o-mini': 'composer-2-fast',
    'gpt-4-turbo': 'composer-2',
    'gpt-3.5-turbo': 'composer-1.5',
    'claude-3-opus': 'claude-4.6-opus-max-thinking',
    'claude-3-sonnet': 'claude-4.6-sonnet-medium-thinking',
    'claude-3.5-sonnet': 'claude-4.5-sonnet-thinking',
    'gemini-pro': 'gemini-3.1-pro',
    // 直通
    'composer-2': 'composer-2',
    'composer-2-fast': 'composer-2-fast',
    'composer-1.5': 'composer-1.5',
    'default': 'default',
  },

  // 模型映射 (Anthropic model → Cursor model)
  // 实际可用模型通过 /v1/models 查询
  anthropicModelMapping: {
    // Claude 4.7 Opus
    'claude-opus-4-7-20250507': 'claude-opus-4-7-thinking-max',
    'claude-opus-4-7': 'claude-opus-4-7-thinking-max',
    // Claude 4.6 Opus
    'claude-opus-4-20250514': 'claude-4.6-opus-max-thinking',
    'claude-opus-4-6': 'claude-4.6-opus-max-thinking',
    // Claude 4.5 Opus
    'claude-opus-4-5': 'claude-4.5-opus-high-thinking',
    // Claude 4.6 Sonnet — non-thinking variant by default (faster, less rate-limited)
    'claude-sonnet-4-6-20250514': 'claude-4.6-sonnet-medium',
    'claude-sonnet-4-6': 'claude-4.6-sonnet-medium',
    // Claude 4.5 Sonnet
    'claude-sonnet-4-5-20241022': 'claude-4.5-sonnet',
    'claude-sonnet-4-5': 'claude-4.5-sonnet',
    // Claude 4 Sonnet
    'claude-sonnet-4-20250514': 'claude-4-sonnet-thinking',
    // Claude Haiku — Cursor has no Haiku model. server.js intercepts haiku
    // requests and rewrites them to claude-sonnet-4-6 (smallest real Claude)
    // BEFORE reaching this mapping, so these entries are belt-and-suspenders.
    'claude-haiku-4-5-20251001': 'claude-4.6-sonnet-medium',
    'claude-haiku-4-5': 'claude-4.6-sonnet-medium',
    'claude-3-5-haiku-20241022': 'claude-4.6-sonnet-medium',
    'claude-3-5-haiku-latest': 'claude-4.6-sonnet-medium',
    'claude-3-haiku-20240307': 'claude-4.6-sonnet-medium',
    // Claude 3.5 family
    'claude-3-5-sonnet-20241022': 'claude-4.5-sonnet',
    'claude-3-5-sonnet-latest': 'claude-4.5-sonnet',
    // Claude 3 family
    'claude-3-opus-20240229': 'claude-4.6-opus-max-thinking',
    'claude-3-opus-latest': 'claude-4.6-opus-max-thinking',
    'claude-3-sonnet-20240229': 'claude-4.6-sonnet-medium',
    // Short aliases (point to latest)
    'claude-opus-4': 'claude-opus-4-7-thinking-max',
    'claude-sonnet-4': 'claude-4-sonnet-thinking',
  },
};

module.exports = config;
