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

// ── Stall-driven elevation (transient response) ──
// The rolling-window p99 is steady-state — it's slow to react to a sudden
// upstream slowdown. To handle transient outages: each time the watchdog
// trips on a model, multiply that model's threshold by ELEVATION_BUMP
// (capped at ELEVATION_CAP). A successful turn resets elevation to 1.0.
// While no stall is occurring, elevation decays exponentially with time
// constant ELEVATION_DECAY_TAU_MS so a transient blip doesn't inflate
// thresholds permanently.
//
// Hard ceiling: even with full elevation, the effective threshold cannot
// exceed baseline × ELEVATION_HARD_CAP_FACTOR. This keeps a runaway from
// hiding a real hang indefinitely.
const ELEVATION_BUMP = 1.5;
const ELEVATION_CAP = 4.0;
const ELEVATION_DECAY_TAU_MS = 5 * 60_000;  // 5-minute time constant
const ELEVATION_HARD_CAP_FACTOR = 4;        // threshold ≤ baseline × 4 always

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

// Per-model state:
//   samples / next   — rolling window of successful-turn maxIdleMs (for p99)
//   elevation        — transient multiplier on threshold, ≥ 1.0
//   lastStallAt      — ms timestamp of most recent stall (drives decay)
//   stallCount       — total stalls observed (informational)
const _state = new Map();

function _slot(model) {
  let s = _state.get(model);
  if (!s) {
    s = {
      samples: [], next: 0,
      elevation: 1.0, lastStallAt: null, stallCount: 0,
    };
    _state.set(model, s);
  }
  return s;
}

// Effective elevation right now: stored value decayed by time-since-last-stall.
// Floors at 1.0 (no de-elevation below baseline).
function _currentElevation(s) {
  if (!s || s.elevation <= 1.0) return 1.0;
  if (!s.lastStallAt) return s.elevation;
  const age = Date.now() - s.lastStallAt;
  if (age <= 0) return s.elevation;
  const decayed = s.elevation * Math.exp(-age / ELEVATION_DECAY_TAU_MS);
  return Math.max(1.0, decayed);
}

// Watchdog tripped — boost this model's elevation so the next attempt has
// more headroom. Idempotent under the cap; consecutive stalls bump
// multiplicatively up to ELEVATION_CAP.
function recordStall(model) {
  if (typeof model !== 'string' || !model) return;
  const s = _slot(model);
  s.stallCount++;
  // Bump the *current* (decayed) elevation, not the stored value, so a
  // long-quiet period followed by a fresh stall starts from ~1.0 again.
  const current = _currentElevation(s);
  s.elevation = Math.min(ELEVATION_CAP, current * ELEVATION_BUMP);
  s.lastStallAt = Date.now();
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
  // A successful turn — upstream is responding. Reset transient elevation
  // back to baseline. (Decay would get us there eventually, but explicit
  // success-clears keeps thresholds tight when conditions are good.)
  if (s.elevation > 1.0) {
    s.elevation = 1.0;
    s.lastStallAt = null;
  }
}

function _percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

// Effective threshold for a model at this moment.
// Returns { pre, post, source: 'baseline'|'adaptive', elevation, p99?, samples? }.
//
// Composition: start with feature-baseline. If we have enough samples,
// switch to p99-derived (clamped to baseline × 2). Then multiply by the
// current elevation factor and clamp to baseline × ELEVATION_HARD_CAP_FACTOR.
function getThreshold(model) {
  const baseline = baselineThresholds(model);
  const s = _state.get(model);

  let basePre, basePost, source;
  if (!s || s.samples.length < ADAPTIVE_MIN_SAMPLES) {
    basePre = baseline.pre;
    basePost = baseline.post;
    source = 'baseline';
  } else {
    const p99 = _percentile(s.samples, 0.99);
    if (p99 == null) {
      basePre = baseline.pre;
      basePost = baseline.post;
      source = 'baseline';
    } else {
      // Clamp to [MIN_PRE_MS, baseline × 2]. The upper bound prevents a
      // noisy outlier from blowing up the threshold and hiding real hangs.
      basePre  = Math.max(MIN_PRE_MS, Math.min(baseline.pre  * 2, Math.round(p99 * PRE_MULTIPLIER)));
      basePost = Math.max(MIN_PRE_MS, Math.min(baseline.post * 2, Math.round(p99 * POST_MULTIPLIER)));
      source = 'adaptive';
    }
  }

  const elevation = _currentElevation(s);
  const hardCapPre  = baseline.pre  * ELEVATION_HARD_CAP_FACTOR;
  const hardCapPost = baseline.post * ELEVATION_HARD_CAP_FACTOR;
  const pre  = Math.min(hardCapPre,  Math.round(basePre  * elevation));
  const post = Math.min(hardCapPost, Math.round(basePost * elevation));

  const out = { pre, post, source, elevation };
  if (s) {
    if (s.samples.length >= ADAPTIVE_MIN_SAMPLES) {
      out.p99 = _percentile(s.samples, 0.99);
    }
    out.samples = s.samples.length;
    out.stallCount = s.stallCount;
  }
  return out;
}

// For /health and debugging.
function getStats() {
  const out = {};
  for (const [model, s] of _state.entries()) {
    if (s.samples.length === 0 && s.stallCount === 0) continue;
    const t = getThreshold(model);
    const entry = {
      samples: s.samples.length,
      thresholdPreMs: t.pre,
      thresholdPostMs: t.post,
      source: t.source,
      elevation: Number(t.elevation.toFixed(3)),
      stallCount: s.stallCount,
    };
    if (s.samples.length > 0) {
      entry.p50 = _percentile(s.samples, 0.5);
      entry.p95 = _percentile(s.samples, 0.95);
      entry.p99 = _percentile(s.samples, 0.99);
      entry.max = Math.max(...s.samples);
    }
    if (s.lastStallAt) entry.secondsSinceLastStall = Math.round((Date.now() - s.lastStallAt) / 1000);
    out[model] = entry;
  }
  return out;
}

// Test hook — wipe all per-model state.
function _resetForTests() { _state.clear(); }

module.exports = {
  classify,
  baselineThresholds,
  recordTurn,
  recordStall,
  getThreshold,
  getStats,
  _resetForTests,
  // Constants exported for tests/observability:
  MIN_PRE_MS,
  PRE_MULTIPLIER,
  POST_MULTIPLIER,
  ADAPTIVE_MIN_SAMPLES,
  ROLLING_WINDOW,
  ELEVATION_BUMP,
  ELEVATION_CAP,
  ELEVATION_DECAY_TAU_MS,
  ELEVATION_HARD_CAP_FACTOR,
};
