// Per-conversation thinking-history store, for proxy-side re-injection of
// the model's prior reasoning into subsequent turns' prompts.
//
// Why this exists:
//
// Cursor's `agent.v1.AgentService/Run` transport (the only one we have
// account access to) strips Anthropic's signed thinking blocks at the
// boundary. The chat-service transport that preserves them is gated on a
// "cloud agents" entitlement our token lacks. So through this proxy, the
// model on Cursor's side starts each user-facing turn fresh — it sees the
// flattened conversation text but not its prior reasoning.
//
// When `CURSOR_REINJECT_THINKING=1`, we keep the model's emitted thinking
// per-conversation in memory and inject it back into the prompt on
// subsequent turns as `<thinking>...</thinking>` segments, attached to the
// matching assistant message. The model sees it as text context rather
// than as its own signed blocks — different semantics from native Anthropic
// extended-thinking, but it gives the model SOMETHING to reference when
// the user asks a follow-up that depends on prior reasoning.
//
// Cost: extra prompt tokens on every continuation, capped by:
//   - CURSOR_REINJECT_THINKING_MAX_BYTES_PER_TURN  (default 4096 bytes per stored turn)
//   - CURSOR_REINJECT_THINKING_MAX_TURNS           (default 5 stored turns per conversation)
//
// Off by default. Opt in if you have reasoning-heavy multi-turn workflows
// and want the model to remember its prior thinking. For typical short-
// answer or tool-call-heavy turns the overhead probably isn't worth it.

const _enabled = process.env.CURSOR_REINJECT_THINKING === '1';

const MAX_BYTES_PER_TURN = (() => {
  const raw = process.env.CURSOR_REINJECT_THINKING_MAX_BYTES_PER_TURN;
  if (raw == null || raw === '') return 4096;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4096;
})();

const MAX_TURNS = (() => {
  const raw = process.env.CURSOR_REINJECT_THINKING_MAX_TURNS;
  if (raw == null || raw === '') return 5;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
})();

// TTL chosen to match the bridge-cache TTL (30 min). If the bridge has
// expired, the thinking history is no longer useful — the conversation
// has gone cold from the proxy's perspective.
const TTL_MS = 30 * 60_000;

// Per-conversation store. Map<convKey, { entries: [{turnIndex, text}],
//                                         lastAccessMs }>
const _store = new Map();

// Strip out `[Tool call: NAME({...})]` substrings — these are hallucinated
// tool-call markers we suppress from the visible response. Don't include
// them in re-injected thinking either; the model would just see noise.
function _scrubThinking(text) {
  if (!text) return '';
  return text.replace(/\[Tool call: [^\]]*\]/g, '').trim();
}

function isEnabled() { return _enabled; }

// Record a turn's thinking content. Called from server.js's onTurnEnded
// path after a successful turn. `turnIndex` is the position of this
// turn's assistant message in the flattened message history (so the
// reader can correlate).
function recordTurnThinking(convKey, turnIndex, text) {
  if (!_enabled) return;
  if (!convKey) return;
  const scrubbed = _scrubThinking(text);
  if (!scrubbed) return;
  const clipped = scrubbed.length > MAX_BYTES_PER_TURN
    ? scrubbed.slice(0, MAX_BYTES_PER_TURN) + '… [truncated]'
    : scrubbed;
  let s = _store.get(convKey);
  if (!s) { s = { entries: [], lastAccessMs: Date.now() }; _store.set(convKey, s); }
  s.entries.push({ turnIndex, text: clipped });
  if (s.entries.length > MAX_TURNS) {
    s.entries.splice(0, s.entries.length - MAX_TURNS);
  }
  s.lastAccessMs = Date.now();
}

// Fetch the thinking history for a conversation, ordered oldest-first.
// Returns an empty array when disabled or absent — caller is allowed to
// call unconditionally.
function getHistory(convKey) {
  if (!_enabled) return [];
  const s = _store.get(convKey);
  if (!s) return [];
  s.lastAccessMs = Date.now();
  return s.entries.slice();
}

// Background eviction. Cheap; only fires when there's actual state.
function _evictStale() {
  const now = Date.now();
  for (const [k, v] of _store) {
    if (now - v.lastAccessMs > TTL_MS) _store.delete(k);
  }
}
const _evictTimer = setInterval(_evictStale, 5 * 60_000);
_evictTimer.unref();

// Test hook.
function _resetForTests() { _store.clear(); }

module.exports = {
  isEnabled,
  recordTurnThinking,
  getHistory,
  _resetForTests,
  MAX_BYTES_PER_TURN,
  MAX_TURNS,
};
