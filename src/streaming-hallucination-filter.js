// Streaming filter that suppresses `[Tool call: NAME({...})]` substrings
// from outbound text deltas before they reach claude-code.
//
// Why this exists:
//
// The model sometimes emits a hallucinated tool call as TEXT instead of as
// a structured tool_use block (see parseHallucinatedToolCalls in
// anthropic-tools.js). The rescue path in server.js synthesizes a real
// tool_use block from those text patterns so the tool actually runs. But
// the *original text* the model wrote was already on the wire by the time
// the rescue runs, so claude-code displays the bracketed string as visible
// junk above the rescued tool's result — `[Tool call: Read({...})]` on one
// line, `Read 1 file (ctrl+o to expand)` on the next.
//
// Real Claude Code never shows that bracketed line. This filter matches
// that behavior: any text delta containing `[Tool call: ...]` is held back
// just long enough to decide whether it's a complete pattern; if so, the
// matched span is dropped before the surrounding text gets forwarded.
//
// Latency: at most one delta's worth. Text that doesn't contain `[` is
// forwarded immediately. Text that begins with `[` is held until either
// (a) the next character disambiguates against `[Tool call: ` prefix
// (flushed immediately), or (b) the complete `[Tool call: NAME({...})]`
// pattern resolves (matched range dropped, surrounding text forwarded).
//
// The full original text (including the suppressed spans) still goes into
// turnState.emittedTextForDetection so the structural rescue can find the
// hits and synthesize tool_use blocks from them.

const TAG = '[Tool call: ';

class StreamingHallucinationFilter {
  constructor({ maxBufferSize = 64 * 1024 } = {}) {
    this._buf = '';
    this._max = maxBufferSize;
  }

  // Feed an incoming text delta. Returns the text that should be forwarded
  // to the client (after suppression). Returns '' if all text is being
  // held back as a potential pattern.
  feed(delta) {
    if (!delta) return '';
    this._buf += delta;
    let out = '';
    // Walk the buffer, repeatedly: flush safe prefix → decide on the
    // leading `[` → suppress or release. Continue until buffer is empty
    // or we hit a "hold" state.
    while (this._buf.length > 0) {
      const bracketIdx = this._buf.indexOf('[');
      if (bracketIdx === -1) {
        // No bracket anywhere — safe to flush everything.
        out += this._buf;
        this._buf = '';
        break;
      }
      // Flush everything before the bracket — that text is unambiguous.
      if (bracketIdx > 0) {
        out += this._buf.slice(0, bracketIdx);
        this._buf = this._buf.slice(bracketIdx);
      }
      // Buffer now starts with `[`. Check the prefix against TAG.
      const lenToCheck = Math.min(this._buf.length, TAG.length);
      const prefixMatches = this._buf.slice(0, lenToCheck) === TAG.slice(0, lenToCheck);
      if (!prefixMatches) {
        // This `[` is definitely NOT the start of `[Tool call: ` — flush
        // just the `[` and continue scanning for the next bracket.
        out += this._buf[0];
        this._buf = this._buf.slice(1);
        continue;
      }
      if (this._buf.length < TAG.length) {
        // Partial prefix match — could become a pattern with more text.
        // Hold and wait for more deltas. Bounded by maxBufferSize.
        break;
      }
      // Buffer starts with the full TAG. Find the closing `]` of the
      // `[Tool call: NAME({...})]` pattern.
      const closeIdx = this._findPatternClose(this._buf);
      if (closeIdx === -1) {
        // Pattern not yet complete — keep buffering, unless we've
        // exceeded the safety limit, in which case flush as text (better
        // to leak some bracketed text than to swallow unbounded content).
        if (this._buf.length > this._max) {
          out += this._buf;
          this._buf = '';
        }
        break;
      }
      // Complete pattern matched — drop the matched span entirely. The
      // structured rescue will read the same range out of
      // emittedTextForDetection and synthesize a real tool_use block.
      this._buf = this._buf.slice(closeIdx + 1);
      // Loop continues — more matches or trailing text may remain in buf.
    }
    return out;
  }

  // Final flush — called at end of turn (text block close, finalize, etc.).
  // Whatever's left in the buffer goes out as plain text. If it's an
  // incomplete pattern the model never finished, we surface it rather than
  // silently swallow user-visible content.
  flush() {
    const out = this._buf;
    this._buf = '';
    return out;
  }

  // Internal: given a buffer starting with TAG, find the index of the
  // closing `]` of the `[Tool call: NAME]` or `[Tool call: NAME({...})]`
  // pattern. Returns -1 if the pattern is not yet complete.
  //
  // Mirrors parseHallucinatedToolCalls in anthropic-tools.js — brace-
  // counting with quoted-string awareness so `{` / `}` inside JSON
  // strings don't perturb depth.
  _findPatternClose(buf) {
    let p = TAG.length;
    // Read tool name up to '(' or ']'.
    while (p < buf.length && buf[p] !== '(' && buf[p] !== ']') p++;
    if (p >= buf.length) return -1;
    if (buf[p] === ']') return p;
    // Must be '(' — expect '({...})' or '(...)'.
    if (buf[p] !== '(') return -1;
    if (p + 1 >= buf.length) return -1;
    if (buf[p + 1] === '{') {
      // JSON args — brace-count.
      let depth = 0;
      let inStr = false;
      let esc = false;
      let q = p + 1;
      while (q < buf.length) {
        const c = buf[q];
        if (esc) { esc = false; q++; continue; }
        if (c === '\\' && inStr) { esc = true; q++; continue; }
        if (c === '"') { inStr = !inStr; q++; continue; }
        if (!inStr) {
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) { q++; break; }
          }
        }
        q++;
      }
      if (depth !== 0) return -1;  // JSON not yet closed
      if (q >= buf.length) return -1;
      if (buf[q] === ')') q++;
      else return -1;
      if (q >= buf.length) return -1;
      if (buf[q] === ']') return q;
      return -1;
    }
    // `(...)` without JSON — find the closing `)` then expect `]`.
    let q = p + 1;
    while (q < buf.length && buf[q] !== ')') q++;
    if (q >= buf.length) return -1;
    q++;  // past ')'
    if (q >= buf.length) return -1;
    if (buf[q] === ']') return q;
    return -1;
  }

  bufferSize() { return this._buf.length; }
}

module.exports = { StreamingHallucinationFilter };
