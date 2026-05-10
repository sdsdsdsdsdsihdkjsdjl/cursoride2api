// Per-model stall threshold computation.
//
// Two layers:
//
// 1. Feature-derived baseline — parse the Cursor model name into features
//    (isThinking, isOpus, effort) and derive a starting threshold from a
//    heuristic formula. Always available, no warm-up needed.
//
// 2. Adaptive — once we have ≥ ADAPTIVE_MIN_SAMPLES successful turns for a
//    model, switch to p99 of observed `maxIdleMs` × multiplier, clamped
//    to [MIN_PRE_MS, baseline × 2]. This lets thresholds tighten when the
//    model is fast and loosen when upstream is slow, without code changes
//    per model.
//
// State is in-memory: lost on restart. After a restart the first
// ADAPTIVE_MIN_SAMPLES turns of each model use baselines, then adaptive
// kicks in. Persisting across restarts could be a follow-up if useful.
//
// Two thresholds per model: pre-content vs post-content.
//   pre  = how long to wait when nothing has been streamed to the client yet.
//          Failing here is safe (failOrRetry can swap to a fresh slot before
//          the client renders anything), so we tolerate less idle time.
//   post = how long to wait once content has flowed to the client. Failing
//          here is expensive — claude-code's wrapper does not auto-retry
//          mid-stream errors. So we wait substantially longer.

const MIN_PRE_MS = 30_000;        // never set thresholds below this
const PRE_MULTIPLIER = 1.5;       // pre threshold = p99 × 1.5
const POST_MULTIPLIER = 2.5;      // post threshold = p99 × 2.5 (more headroom)
const ADAPTIVE_MIN_SAMPLES = 20;  // need this many before trusting p99
const ROLLING_WINDOW = 50;        // rolling window size per model

function classify(model) {
  if (typeof model !== 'string') model = '';
  return {
    isThinking: /-thinking(?:-|$)/.test(model),
    isOpus:     /opus/.test(model),
    isSonnet:   /sonnet/.test(model),
    effort:     (model.match(/-(low|medium|high|xhigh|max)(?:-|$)/) || [])[1] || null,
  };
}

// Baseline: derive thresholds from name features.
//
//   base 60 s pre-content
//   + 30 s if opus (heavier than sonnet/composer)
//   + 60 s if thinking variant (reasoning pauses are real)
//   + 30 s if effort=max
//   + 15 s if effort=xhigh
//   post = pre × 1.5
//
// Examples:
//   claude-opus-4-7-thinking-max      → 180 s pre / 270 s post
//   claude-opus-4-7-thinking-medium   → 150 s / 225 s
//   claude-opus-4-7-max               → 120 s / 180 s
//   claude-4.6-opus-max-thinking      → 180 s / 270 s
//   claude-4.5-sonnet-thinking        → 120 s / 180 s
//   claude-4.5-sonnet                 →  60 s /  90 s
//   composer-2-fast / unknown         →  60 s /  90 s
function baselineThresholds(model) {
  const m = classify(model);
  let pre = 60_000;
  if (m.isOpus)             pre += 30_000;
  if (m.isThinking)         pre += 60_000;
  if (m.effort === 'max')   pre += 30_000;
  if (m.effort === 'xhigh') pre += 15_000;
  return { pre, post: Math.round(pre * 1.5) };
}

// Per-model rolling window: { samples: number[], next: number }
const _state = new Map();

function _slot(model) {
  let s = _state.get(model);
  if (!s) { s = { samples: [], next: 0 }; _state.set(model, s); }
  return s;
}

// Record the maxIdleMs from a SUCCESSFUL turn. Failed turns are excluded
// because their idle gap was capped by the watchdog and would skew the
// distribution downward (or by a hard error and would skew it artificially).
function recordTurn(model, maxIdleMs) {
  if (typeof model !== 'string' || !model) return;
  if (typeof maxIdleMs !== 'number' || !Number.isFinite(maxIdleMs) || maxIdleMs < 0) return;
  const s = _slot(model);
  if (s.samples.length < ROLLING_WINDOW) {
    s.samples.push(maxIdleMs);
  } else {
    s.samples[s.next] = maxIdleMs;
    s.next = (s.next + 1) % ROLLING_WINDOW;
  }
}

function _percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

// Effective threshold for a model at this moment.
// Returns { pre, post, source: 'baseline'|'adaptive', p99?, samples? }.
function getThreshold(model) {
  const baseline = baselineThresholds(model);
  const s = _state.get(model);
  if (!s || s.samples.length < ADAPTIVE_MIN_SAMPLES) {
    return { pre: baseline.pre, post: baseline.post, source: 'baseline' };
  }
  const p99 = _percentile(s.samples, 0.99);
  if (p99 == null) {
    return { pre: baseline.pre, post: baseline.post, source: 'baseline' };
  }
  // Clamp to [MIN_PRE_MS, baseline × 2]. The upper bound prevents a noisy
  // outlier (e.g. a single 300 s gap) from blowing up the threshold and
  // hiding real hangs. If p99 routinely exceeds baseline × 2 we'd rather
  // see retries (and be told there's a real problem) than silently extend.
  const adaptivePre  = Math.max(MIN_PRE_MS, Math.min(baseline.pre  * 2, Math.round(p99 * PRE_MULTIPLIER)));
  const adaptivePost = Math.max(MIN_PRE_MS, Math.min(baseline.post * 2, Math.round(p99 * POST_MULTIPLIER)));
  return {
    pre: adaptivePre,
    post: adaptivePost,
    source: 'adaptive',
    p99,
    samples: s.samples.length,
  };
}

// For /health and debugging.
function getStats() {
  const out = {};
  for (const [model, s] of _state.entries()) {
    if (s.samples.length === 0) continue;
    const t = getThreshold(model);
    out[model] = {
      samples: s.samples.length,
      p50: _percentile(s.samples, 0.5),
      p95: _percentile(s.samples, 0.95),
      p99: _percentile(s.samples, 0.99),
      max: Math.max(...s.samples),
      thresholdPreMs: t.pre,
      thresholdPostMs: t.post,
      source: t.source,
    };
  }
  return out;
}

// Test hook — wipe all per-model state.
function _resetForTests() { _state.clear(); }

module.exports = {
  classify,
  baselineThresholds,
  recordTurn,
  getThreshold,
  getStats,
  _resetForTests,
  // Constants exported for tests/observability:
  MIN_PRE_MS,
  PRE_MULTIPLIER,
  POST_MULTIPLIER,
  ADAPTIVE_MIN_SAMPLES,
  ROLLING_WINDOW,
};
