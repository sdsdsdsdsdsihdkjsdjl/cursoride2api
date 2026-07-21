// ═══════════════════════════════════════════════
//  CursorIDE2API - Anthropic request preprocessing
// ═══════════════════════════════════════════════
//
// Optimizations ported from caozhiyuan/copilot-api:
//   - Compaction detection (Claude Code's `/compact` and OpenCode's
//     anchor-context summarization land as a special prompt; route them
//     to a small/cheap model so they don't consume a full Claude turn).
//   - Subagent marker detection (`__SUBAGENT_MARKER__` injected by the
//     Claude Code / OpenCode plugin in a <system-reminder>; lets us
//     route subagent traffic to a smaller model).
//   - IDE tool sanitization (`mcp__ide__executeCode` is a no-op probe
//     Claude Code injects when the IDE plugin is active; drop it so
//     warmup-style requests stay tool-less).

// Compaction prompt fingerprints (Claude Code + OpenCode variants).
const COMPACT_SYSTEM_PROMPT_STARTS = [
  'You are a helpful AI assistant tasked with summarizing conversations',
  'You are an anchored context summarization assistant for coding sessions.',
];

const COMPACT_TEXT_ONLY_GUARD =
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';
const COMPACT_SUMMARY_PROMPT_START =
  'Your task is to create a detailed summary of the conversation so far';
const COMPACT_MESSAGE_SECTIONS = ['Pending Tasks:', 'Current Work:'];

const COMPACT_AUTO_CONTINUE_PROMPT_STARTS = [
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
  'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
  'The previous request exceeded the provider\'s size limit due to large media attachments. The conversation was compacted and media files were removed from context.',
];

const SUBAGENT_MARKER_PREFIX = '__SUBAGENT_MARKER__';

const IDE_EXECUTE_CODE_TOOL = 'mcp__ide__executeCode';
const IDE_GET_DIAGNOSTICS_TOOL = 'mcp__ide__getDiagnostics';

// Compaction kinds: 0 = not a compact request, 1 = compact request,
// 2 = compact auto-continue (resume after compaction).
const COMPACT_NONE = 0;
const COMPACT_REQUEST = 1;
const COMPACT_AUTO_CONTINUE = 2;

// ═══════════════════════════════════════════════
//  Compaction detection
// ═══════════════════════════════════════════════

function _candidateText(message) {
  if (!message || message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => (b.text.startsWith('<system-reminder>') ? '' : b.text))
    .filter(t => t.length > 0)
    .join('\n\n');
}

function _isCompactMessage(lastMessage) {
  const text = _candidateText(lastMessage);
  if (!text) return false;
  return (
    text.includes(COMPACT_TEXT_ONLY_GUARD) &&
    text.includes(COMPACT_SUMMARY_PROMPT_START) &&
    COMPACT_MESSAGE_SECTIONS.some(s => text.includes(s))
  );
}

function _isCompactAutoContinueMessage(lastMessage) {
  const text = _candidateText(lastMessage);
  if (!text) return false;
  return COMPACT_AUTO_CONTINUE_PROMPT_STARTS.some(p => text.startsWith(p));
}

function _systemHasCompactPrompt(system) {
  if (!system) return false;
  if (typeof system === 'string') {
    return COMPACT_SYSTEM_PROMPT_STARTS.some(p => system.startsWith(p));
  }
  if (!Array.isArray(system)) return false;
  return system.some(
    msg =>
      msg && typeof msg.text === 'string' &&
      COMPACT_SYSTEM_PROMPT_STARTS.some(p => msg.text.startsWith(p))
  );
}

function detectCompactType(payload) {
  if (!payload || !Array.isArray(payload.messages)) return COMPACT_NONE;
  const lastMessage = payload.messages.at(-1);
  if (lastMessage && _isCompactMessage(lastMessage)) return COMPACT_REQUEST;
  if (lastMessage && _isCompactAutoContinueMessage(lastMessage)) return COMPACT_AUTO_CONTINUE;
  if (_systemHasCompactPrompt(payload.system)) return COMPACT_REQUEST;
  return COMPACT_NONE;
}

// ═══════════════════════════════════════════════
//  Subagent marker
// ═══════════════════════════════════════════════
//
// Claude Code / OpenCode plugin injects a <system-reminder> in the FIRST
// user message of a subagent turn:
//   <system-reminder>__SUBAGENT_MARKER__{"session_id":"...","agent_id":"...","agent_type":"..."}</system-reminder>
// Returns the parsed marker object, or null.

function _parseMarkerFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const startTag = '<system-reminder>';
  const endTag = '</system-reminder>';
  let pos = 0;
  while (true) {
    const start = text.indexOf(startTag, pos);
    if (start === -1) return null;
    const contentStart = start + startTag.length;
    const end = text.indexOf(endTag, contentStart);
    if (end === -1) return null;
    const inner = text.slice(contentStart, end);
    const idx = inner.indexOf(SUBAGENT_MARKER_PREFIX);
    if (idx === -1) {
      pos = end + endTag.length;
      continue;
    }
    const json = inner.slice(idx + SUBAGENT_MARKER_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(json);
      if (parsed && parsed.session_id && parsed.agent_id && parsed.agent_type) {
        return parsed;
      }
    } catch (e) { /* fall through */ }
    pos = end + endTag.length;
  }
}

function detectSubagentMarker(payload) {
  if (!payload || !Array.isArray(payload.messages)) return null;
  // Find the first user message with array content
  const firstUser = payload.messages.find(
    m => m && m.role === 'user' && Array.isArray(m.content)
  );
  if (!firstUser) return null;
  for (const block of firstUser.content) {
    if (block && block.type === 'text') {
      const marker = _parseMarkerFromText(block.text);
      if (marker) return marker;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════
//  IDE tool sanitization
// ═══════════════════════════════════════════════
//
// Mutates `tools` in place to drop `mcp__ide__executeCode` (when not
// deferred) so requests stay tool-less for the warmup small-model path.

function sanitizeIdeTools(payload) {
  if (!payload || !Array.isArray(payload.tools) || payload.tools.length === 0) return;
  payload.tools = payload.tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object') return [tool];
    if (tool.name === IDE_EXECUTE_CODE_TOOL && !tool.defer_loading) return [];
    return [tool];
  });
}

// ═══════════════════════════════════════════════
//  Combined preprocess pass + classification
// ═══════════════════════════════════════════════
//
// One call from server.js per /v1/messages — returns a "decision" object
// the handler uses to pick the effective model and log the classification.
//
// Mutates `payload.tools` (sanitizeIdeTools) but otherwise non-destructive.

function preprocessAnthropicRequest(payload) {
  if (!payload) return { compactType: COMPACT_NONE, subagentMarker: null };
  sanitizeIdeTools(payload);
  return {
    compactType: detectCompactType(payload),
    subagentMarker: detectSubagentMarker(payload),
  };
}

module.exports = {
  COMPACT_NONE,
  COMPACT_REQUEST,
  COMPACT_AUTO_CONTINUE,
  detectCompactType,
  detectSubagentMarker,
  sanitizeIdeTools,
  preprocessAnthropicRequest,
};
