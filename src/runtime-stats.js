// Runtime statistics aggregator.
//
// Collects per-turn outcomes and distribution metrics so we can answer
// questions like:
//   * What fraction of turns succeed on first try vs need retries vs fail?
//   * What's the firstFrame p99 for opus-thinking-max in the last hour?
//   * How often is the cascade-detection path firing?
//
// State:
//   - per-model lifetime counters (cheap, plain numbers)
//   - per-model t-digests for durationMs / firstFrameMs / maxIdleMs
//     distributions (memory-light, accurate at the tail where we care most)
//   - a ring buffer of the last N turn records, used for time-windowed views
//     (last 1h / last 24h) — t-digests can't easily forget old data so we
//     replay from the ring on demand.
//
// Persistence: snapshotted to JSON at a configurable path so restarts don't
// lose long-term aggregates. Snapshot is debounced — only writes when state
// is dirty and at most once per RUNTIME_STATS_PERSIST_MS interval. The ring
// buffer is also persisted so time-windowed views survive a restart.

const fs = require('fs');
const path = require('path');
const { TDigest } = require('tdigest');

const STATS_FILE = process.env.RUNTIME_STATS_FILE
  || path.join(__dirname, '..', 'logs', 'runtime-stats.json');
const PERSIST_INTERVAL_MS = parseInt(process.env.RUNTIME_STATS_PERSIST_MS || '60000', 10);
const RECENT_RING = parseInt(process.env.RUNTIME_STATS_RECENT || '1000', 10);
const SCHEMA_VERSION = 1;

function _newDigest() { return new TDigest(); }
function _digestToJSON(d) { return d.toArray(); }
function _digestFromJSON(arr) {
  const d = new TDigest();
  if (Array.isArray(arr) && arr.length) d.push_centroid(arr);
  return d;
}
function _safePercentile(d, p) {
  if (!d || d.size() === 0) return null;
  const v = d.percentile(p);
  return Number.isFinite(v) ? Math.round(v) : null;
}

function _newModelStats() {
  return {
    total: 0,
    success: 0,
    fail: 0,
    retried: 0,    // turns that needed at least 1 retry
    recovered: 0,  // turns that succeeded after >=1 retry
    totalRetries: 0,
    totalStalls: 0,
    totalTransportErrors: 0,
    totalCascades: 0,
    durationDigest: _newDigest(),
    firstFrameDigest: _newDigest(),
    maxIdleDigest: _newDigest(),
    firstSeenAt: Date.now(),
  };
}

function _modelStatsToJSON(s) {
  return {
    total: s.total, success: s.success, fail: s.fail,
    retried: s.retried, recovered: s.recovered,
    totalRetries: s.totalRetries,
    totalStalls: s.totalStalls,
    totalTransportErrors: s.totalTransportErrors,
    totalCascades: s.totalCascades,
    durationDigest: _digestToJSON(s.durationDigest),
    firstFrameDigest: _digestToJSON(s.firstFrameDigest),
    maxIdleDigest: _digestToJSON(s.maxIdleDigest),
    firstSeenAt: s.firstSeenAt,
  };
}

function _modelStatsFromJSON(j) {
  return {
    total: j.total || 0, success: j.success || 0, fail: j.fail || 0,
    retried: j.retried || 0, recovered: j.recovered || 0,
    totalRetries: j.totalRetries || 0,
    totalStalls: j.totalStalls || 0,
    totalTransportErrors: j.totalTransportErrors || 0,
    totalCascades: j.totalCascades || 0,
    durationDigest: _digestFromJSON(j.durationDigest),
    firstFrameDigest: _digestFromJSON(j.firstFrameDigest),
    maxIdleDigest: _digestFromJSON(j.maxIdleDigest),
    firstSeenAt: j.firstSeenAt || Date.now(),
  };
}

class RuntimeStats {
  constructor() {
    this.byModel = new Map();
    this.recent = [];           // ring buffer of last RECENT_RING records
    this._dirty = false;
    this._lastSavedAt = 0;
    this._persistTimer = null;
    this._loadFromDisk();
  }

  _slot(model) {
    let s = this.byModel.get(model);
    if (!s) { s = _newModelStats(); this.byModel.set(model, s); }
    return s;
  }

  // record: {
  //   model, outcome ('success' | 'fail'),
  //   durationMs?, firstFrameMs?, maxIdleMs?,
  //   retries, transportErrors, stalls, cascadeDetected,
  // }
  recordTurnEnd(record) {
    if (!record || typeof record.model !== 'string' || !record.model) return;
    const s = this._slot(record.model);
    s.total++;
    if (record.outcome === 'success') s.success++;
    else s.fail++;
    if (record.retries > 0) {
      s.retried++;
      if (record.outcome === 'success') s.recovered++;
    }
    s.totalRetries += record.retries || 0;
    s.totalStalls += record.stalls || 0;
    s.totalTransportErrors += record.transportErrors || 0;
    s.totalCascades += record.cascadeDetected ? 1 : 0;

    if (typeof record.durationMs === 'number' && record.durationMs >= 0) {
      s.durationDigest.push(record.durationMs);
    }
    if (typeof record.firstFrameMs === 'number' && record.firstFrameMs >= 0) {
      s.firstFrameDigest.push(record.firstFrameMs);
    }
    if (typeof record.maxIdleMs === 'number' && record.maxIdleMs >= 0) {
      s.maxIdleDigest.push(record.maxIdleMs);
    }

    // Ring buffer for time-windowed views.
    const compactRecord = {
      ts: Date.now(),
      model: record.model,
      outcome: record.outcome,
      durationMs: record.durationMs ?? null,
      firstFrameMs: record.firstFrameMs ?? null,
      maxIdleMs: record.maxIdleMs ?? null,
      retries: record.retries || 0,
      transportErrors: record.transportErrors || 0,
      stalls: record.stalls || 0,
      cascadeDetected: !!record.cascadeDetected,
    };
    this.recent.push(compactRecord);
    if (this.recent.length > RECENT_RING) {
      this.recent.splice(0, this.recent.length - RECENT_RING);
    }
    this._dirty = true;
  }

  // window = 'lifetime' | 'last1h' | 'last24h' | a number of ms
  // model = optional filter
  getStats({ window = 'lifetime', model } = {}) {
    const filterModel = model || null;
    if (window === 'lifetime') {
      // Use the lifetime per-model digests
      const out = { window, models: {} };
      let g = null;
      for (const [m, s] of this.byModel.entries()) {
        if (filterModel && m !== filterModel) continue;
        out.models[m] = this._summarize(s);
      }
      out.totals = this._totals(out.models);
      return out;
    }

    // Time-windowed: replay the ring. Build per-model digests on the fly.
    const sinceMs = (typeof window === 'number')
      ? window
      : window === 'last1h' ? 60 * 60_000
      : window === 'last24h' ? 24 * 60 * 60_000
      : 60 * 60_000;
    const cutoff = Date.now() - sinceMs;
    const tmp = new Map();
    for (const r of this.recent) {
      if (r.ts < cutoff) continue;
      if (filterModel && r.model !== filterModel) continue;
      let s = tmp.get(r.model);
      if (!s) { s = _newModelStats(); s.firstSeenAt = r.ts; tmp.set(r.model, s); }
      s.total++;
      if (r.outcome === 'success') s.success++;
      else s.fail++;
      if (r.retries > 0) {
        s.retried++;
        if (r.outcome === 'success') s.recovered++;
      }
      s.totalRetries += r.retries;
      s.totalStalls += r.stalls;
      s.totalTransportErrors += r.transportErrors;
      s.totalCascades += r.cascadeDetected ? 1 : 0;
      if (typeof r.durationMs === 'number') s.durationDigest.push(r.durationMs);
      if (typeof r.firstFrameMs === 'number') s.firstFrameDigest.push(r.firstFrameMs);
      if (typeof r.maxIdleMs === 'number') s.maxIdleDigest.push(r.maxIdleMs);
    }
    const out = { window, models: {} };
    for (const [m, s] of tmp.entries()) out.models[m] = this._summarize(s);
    out.totals = this._totals(out.models);
    return out;
  }

  _summarize(s) {
    const succRate = s.total > 0 ? s.success / s.total : null;
    const firstTryRate = s.total > 0 ? (s.success - s.recovered) / s.total : null;
    return {
      total: s.total,
      success: s.success,
      fail: s.fail,
      retried: s.retried,
      recovered: s.recovered,
      totalRetries: s.totalRetries,
      totalStalls: s.totalStalls,
      totalTransportErrors: s.totalTransportErrors,
      totalCascades: s.totalCascades,
      successRate: succRate != null ? Number(succRate.toFixed(4)) : null,
      firstTryRate: firstTryRate != null ? Number(firstTryRate.toFixed(4)) : null,
      durationMs: {
        p50: _safePercentile(s.durationDigest, 0.50),
        p95: _safePercentile(s.durationDigest, 0.95),
        p99: _safePercentile(s.durationDigest, 0.99),
        n: s.durationDigest.size(),
      },
      firstFrameMs: {
        p50: _safePercentile(s.firstFrameDigest, 0.50),
        p95: _safePercentile(s.firstFrameDigest, 0.95),
        p99: _safePercentile(s.firstFrameDigest, 0.99),
        n: s.firstFrameDigest.size(),
      },
      maxIdleMs: {
        p50: _safePercentile(s.maxIdleDigest, 0.50),
        p95: _safePercentile(s.maxIdleDigest, 0.95),
        p99: _safePercentile(s.maxIdleDigest, 0.99),
        n: s.maxIdleDigest.size(),
      },
    };
  }

  _totals(models) {
    const fields = ['total', 'success', 'fail', 'retried', 'recovered',
      'totalRetries', 'totalStalls', 'totalTransportErrors', 'totalCascades'];
    const t = {};
    for (const f of fields) t[f] = 0;
    for (const m of Object.values(models)) for (const f of fields) t[f] += m[f] || 0;
    t.successRate = t.total > 0 ? Number((t.success / t.total).toFixed(4)) : null;
    t.firstTryRate = t.total > 0
      ? Number(((t.success - t.recovered) / t.total).toFixed(4)) : null;
    return t;
  }

  // ── Persistence ──
  _loadFromDisk() {
    try {
      if (!fs.existsSync(STATS_FILE)) return;
      const raw = fs.readFileSync(STATS_FILE, 'utf8');
      const j = JSON.parse(raw);
      if (j.schema !== SCHEMA_VERSION) return; // future-proof; ignore old format
      this.byModel = new Map();
      for (const [m, ms] of Object.entries(j.byModel || {})) {
        this.byModel.set(m, _modelStatsFromJSON(ms));
      }
      if (Array.isArray(j.recent)) {
        this.recent = j.recent.slice(-RECENT_RING);
      }
    } catch (e) {
      // Corrupt file or read error; start fresh.
      console.error(`[runtime-stats] load failed: ${e.message}`);
    }
  }

  _saveToDisk() {
    if (!this._dirty) return;
    const dir = path.dirname(STATS_FILE);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) { /* ignore */ }
    const obj = {
      schema: SCHEMA_VERSION,
      savedAt: Date.now(),
      byModel: {},
      recent: this.recent,
    };
    for (const [m, s] of this.byModel.entries()) {
      obj.byModel[m] = _modelStatsToJSON(s);
    }
    try {
      // Atomic-ish: write tmp + rename.
      const tmp = STATS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, STATS_FILE);
      this._dirty = false;
      this._lastSavedAt = Date.now();
    } catch (e) {
      console.error(`[runtime-stats] save failed: ${e.message}`);
    }
  }

  startPersistence() {
    if (this._persistTimer) return;
    this._persistTimer = setInterval(() => this._saveToDisk(), PERSIST_INTERVAL_MS);
    this._persistTimer.unref();
    // Final save on graceful shutdown.
    const shutdown = () => { try { this._saveToDisk(); } catch { /* ignore */ } };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('beforeExit', shutdown);
  }

  // Test hook
  _resetForTests() {
    this.byModel.clear();
    this.recent = [];
    this._dirty = false;
  }
}

const _instance = new RuntimeStats();

module.exports = {
  recordTurnEnd: (r) => _instance.recordTurnEnd(r),
  getStats: (opts) => _instance.getStats(opts),
  startPersistence: () => _instance.startPersistence(),
  saveNow: () => _instance._saveToDisk(),
  _resetForTests: () => _instance._resetForTests(),
  // For periodic-log helper to access cheaply:
  _instance,
  // Constants exported for tests
  RECENT_RING,
  SCHEMA_VERSION,
};
