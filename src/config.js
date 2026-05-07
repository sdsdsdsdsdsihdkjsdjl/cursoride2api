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
    'claude-3-opus': 'claude-4.6-opus-max',
    'claude-3-sonnet': 'claude-4.6-sonnet-medium',
    'claude-3.5-sonnet': 'claude-4.5-sonnet',
    'gemini-pro': 'gemini-3.1-pro',
    // 直通
    'composer-2': 'composer-2',
    'composer-2-fast': 'composer-2-fast',
    'composer-1.5': 'composer-1.5',
    'default': 'default',
  },

  // 模型映射 (Anthropic model → Cursor model)
  anthropicModelMapping: {
    // Claude 4.x family
    'claude-opus-4-20250514': 'claude-4.6-opus-max',
    'claude-opus-4-6': 'claude-4.6-opus-max',
    'claude-sonnet-4-20250514': 'claude-4.5-sonnet',
    'claude-sonnet-4-6': 'claude-4.5-sonnet',
    // Claude 3.5 family
    'claude-3-5-sonnet-20241022': 'claude-3.5-sonnet',
    'claude-3-5-sonnet-latest': 'claude-3.5-sonnet',
    'claude-3-5-haiku-20241022': 'claude-3.5-haiku',
    'claude-3-5-haiku-latest': 'claude-3.5-haiku',
    // Claude 3 family
    'claude-3-opus-20240229': 'claude-4.6-opus-max',
    'claude-3-opus-latest': 'claude-4.6-opus-max',
    'claude-3-sonnet-20240229': 'claude-4.6-sonnet-medium',
    'claude-3-haiku-20240307': 'claude-3-haiku',
    // Claude 4.7 family
    'claude-opus-4-7-20250507': 'claude-4.7-opus-max',
    'claude-opus-4-7': 'claude-4.7-opus-max',
    // Short aliases
    'claude-opus-4': 'claude-4.7-opus-max',
    'claude-sonnet-4': 'claude-4.5-sonnet',
  },
};

module.exports = config;
