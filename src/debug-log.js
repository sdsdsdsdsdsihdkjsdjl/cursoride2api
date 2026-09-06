// ═══════════════════════════════════════════════
//  CursorIDE2API - Debug logging
// ═══════════════════════════════════════════════
//
//  Opt-in structured logging for error triage. Enabled by setting:
//
//    DEBUG_LOG=1         → log errors + request summaries to a file
//    DEBUG_LOG=verbose   → also log per-request bodies, tool calls, and
//                          the raw decoded Cursor wire errors
//    DEBUG_LOG_DIR=path  → override default log directory
//
//  Output: one JSON object per line, written to
//    <dir>/server-YYYY-MM-DD.log
//  Easy to grep / parse / tail.

const fs = require('fs');
const path = require('path');

const MODE = (process.env.DEBUG_LOG || '').toLowerCase();
const ENABLED = MODE === '1' || MODE === 'true' || MODE === 'verbose';
const VERBOSE = MODE === 'verbose';

const DIR = process.env.DEBUG_LOG_DIR
  || path.join(__dirname, '..', 'logs');

let logFilePath = null;
let logFileFd = null;
let inited = false;

function init() {
  if (inited) return;
  inited = true;
  if (!ENABLED) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    logFilePath = path.join(DIR, `server-${today}.log`);
    logFileFd = fs.openSync(logFilePath, 'a');
    // Bootstrap entry so the user sees the file is alive
    write({ ts: now(), level: 'info', event: 'log_started', mode: VERBOSE ? 'verbose' : 'basic', file: logFilePath });
    console.log(`  📝 Debug log → ${logFilePath} (mode=${VERBOSE ? 'verbose' : 'basic'})`);
  } catch (e) {
    console.error(`  ❌ Failed to open debug log: ${e.message}`);
    logFileFd = null;
  }
}

function now() {
  return new Date().toISOString();
}

function write(obj) {
  if (!logFileFd) return;
  try {
    fs.writeSync(logFileFd, JSON.stringify(obj) + '\n');
  } catch (e) {
    // Don't crash on log-write failure
  }
}

// Truncate large fields so we don't blow up the log file with multi-MB
// system prompts or huge tool schemas.
function clip(value, maxBytes = 4096) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length <= maxBytes) return value;
    return value.slice(0, maxBytes) + `…[+${value.length - maxBytes} chars]`;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json.length <= maxBytes) return value;
      return json.slice(0, maxBytes) + `…[+${json.length - maxBytes} chars]`;
    } catch {
      return '[unserializable]';
    }
  }
  return value;
}

// Summarize an Anthropic /v1/messages body for log purposes — never include
// the raw conversation text in basic mode, only counts and identifiers.
function summarizeRequest(body) {
  const b = body || {};
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const summary = {
    model: b.model,
    stream: !!b.stream,
    max_tokens: b.max_tokens,
    msg_count: msgs.length,
    msg_roles: msgs.map(m => m && m.role).filter(Boolean),
    tool_count: tools.length,
    tool_names: tools.map(t => t && t.name).filter(Boolean).slice(0, 50),
    has_system: !!b.system,
    has_tool_results: msgs.some(m =>
      m && Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result')
    ),
    bytes: (() => {
      try { return JSON.stringify(b).length; } catch { return -1; }
    })(),
  };
  if (VERBOSE) {
    summary.first_user_text = clip(extractFirstUserText(msgs), 500);
  }
  return summary;
}

function extractFirstUserText(messages) {
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'text' && typeof c.text === 'string') return c.text;
      }
    }
  }
  return '';
}

// ═══════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════

function isEnabled() {
  return ENABLED;
}

function isVerbose() {
  return VERBOSE;
}

// Generic structured log entry.
function log(level, event, ctx = {}) {
  if (!logFileFd) return;
  write({ ts: now(), level, event, ...ctx });
}

function info(event, ctx) { log('info', event, ctx); }
function warn(event, ctx) { log('warn', event, ctx); }
function error(event, ctx) { log('error', event, ctx); }

// Specialized helpers used by server.js / cursor-agent.js.

function logRequest(req, body, derived) {
  if (!logFileFd) return;
  const ctx = {
    request_id: derived.requestId,
    model_requested: derived.requestedModel,
    model_effective: derived.effectiveModel,
    model_cursor: derived.cursorModel,
    is_continuation: !!derived.isContinuation,
    conv_key: derived.convKey,
    bridge_key: derived.bridgeKey,
    body: summarizeRequest(body),
    method: req.method,
    path: req.path,
    remote: req.ip,
  };
  if (VERBOSE && body) {
    ctx.body_full = clip(body, 32 * 1024);
  }
  log('info', 'request_received', ctx);
}

function logCursorError(ctx, errMsg, errDetails) {
  log('error', 'cursor_upstream_error', {
    ...ctx,
    error: errMsg,
    cursor_details: errDetails || null,
  });
}

function logProxyError(ctx, errMsg, stack) {
  log('error', 'proxy_error', {
    ...ctx,
    error: errMsg,
    stack: stack || null,
  });
}

function logToolCall(ctx, toolName, args) {
  log('info', 'tool_call', {
    ...ctx,
    tool_name: toolName,
    args: VERBOSE ? clip(args, 2048) : { keys: Object.keys(args || {}) },
  });
}

function logToolResult(ctx, summary) {
  log('info', 'tool_result_sent', { ...ctx, ...summary });
}

function logTurnEnded(ctx, tokens, stopReason, toolCalls) {
  log('info', 'turn_ended', {
    ...ctx,
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    stop_reason: stopReason,
    tool_calls: toolCalls,
  });
}

module.exports = {
  init,
  isEnabled,
  isVerbose,
  info,
  warn,
  error,
  logRequest,
  logCursorError,
  logProxyError,
  logToolCall,
  logToolResult,
  logTurnEnded,
};
