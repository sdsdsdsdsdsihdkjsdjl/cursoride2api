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
const CONN_EVENT_RING = parseInt(process.env.RUNTIME_STATS_CONN_RING || '500', 10);
// v2: turn records carry mode (stream|nonstream + fresh|cont) and finer
// latencies (firstTextMs/firstToolMs/toolCount); a parallel byModelMode
// aggregate lets you query "all stream continuations of opus-thinking-max".
// v1 stat files won't load — they'll start fresh and rebuild.
const SCHEMA_VERSION = 2;

// modeKey: stable cardinality (4 values) regardless of model count, so the
// per-(model, mode) cross-product stays bounded.
function modeKeyOf({ isStream, isContinuation }) {
  return `${isStream ? 'stream' : 'nonstream'}|${isContinuation ? 'cont' : 'fresh'}`;
}

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
    totalToolCalls: 0,
    durationDigest:    _newDigest(),
    firstFrameDigest:  _newDigest(),
    firstTextDigest:   _newDigest(),
    firstToolDigest:   _newDigest(),
    maxIdleDigest:     _newDigest(),
    inputTokensDigest: _newDigest(),
    outputTokensDigest: _newDigest(),
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
    totalToolCalls: s.totalToolCalls,
    durationDigest:    _digestToJSON(s.durationDigest),
    firstFrameDigest:  _digestToJSON(s.firstFrameDigest),
    firstTextDigest:   _digestToJSON(s.firstTextDigest),
    firstToolDigest:   _digestToJSON(s.firstToolDigest),
    maxIdleDigest:     _digestToJSON(s.maxIdleDigest),
    inputTokensDigest: _digestToJSON(s.inputTokensDigest),
    outputTokensDigest: _digestToJSON(s.outputTokensDigest),
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
    totalToolCalls: j.totalToolCalls || 0,
    durationDigest:    _digestFromJSON(j.durationDigest),
    firstFrameDigest:  _digestFromJSON(j.firstFrameDigest),
    firstTextDigest:   _digestFromJSON(j.firstTextDigest),
    firstToolDigest:   _digestFromJSON(j.firstToolDigest),
    maxIdleDigest:     _digestFromJSON(j.maxIdleDigest),
    inputTokensDigest: _digestFromJSON(j.inputTokensDigest),
    outputTokensDigest: _digestFromJSON(j.outputTokensDigest),
    firstSeenAt: j.firstSeenAt || Date.now(),
  };
}

class RuntimeStats {
  constructor() {
    this.byModel = new Map();         // model → ModelStats (rollup across modes)
    this.byModelMode = new Map();     // `${model}|${modeKey}` → ModelStats
    this.recent = [];                 // ring buffer of last RECENT_RING turn records
    // Connection lifecycle aggregates — separate from turn stats.
    this.connections = {
      lifetimeDigest:    _newDigest(), // ageMs at close
      streamsServedDigest: _newDigest(), // streams served per closed connection
      closeReasonCounts: {},  // 'goaway' | 'error' | 'idle-recycle' | 'shutdown' | ...
      totalOpens: 0,
      totalCloses: 0,
      perSlot: {},  // slot index → { opens, closes, currentClientOpenedAt }
    };
    this.connectionEvents = [];       // ring of recent connection events
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
  _slotMode(model, modeKey) {
    const k = `${model}|${modeKey}`;
    let s = this.byModelMode.get(k);
    if (!s) { s = _newModelStats(); this.byModelMode.set(k, s); }
    return s;
  }
  _connSlotKey(slot) {
    if (slot == null) return 'unknown';
    if (!this.connections.perSlot[slot]) {
      this.connections.perSlot[slot] = { opens: 0, closes: 0, currentClientOpenedAt: null };
    }
    return slot;
  }

  // record: {
  //   model, outcome ('success' | 'fail'),
  //   isStream (bool), isContinuation (bool),
  //   durationMs?, firstFrameMs?, firstTextMs?, firstToolMs?, maxIdleMs?,
  //   retries, transportErrors, stalls, cascadeDetected,
  //   toolCount?, inputTokens?, outputTokens?,
  // }
  recordTurnEnd(record) {
    if (!record || typeof record.model !== 'string' || !record.model) return;
    const modeKey = modeKeyOf({
      isStream: !!record.isStream,
      isContinuation: !!record.isContinuation,
    });

    // Update both per-model rollup and per-(model, mode) breakdown.
    for (const s of [this._slot(record.model), this._slotMode(record.model, modeKey)]) {
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
      s.totalToolCalls += record.toolCount || 0;

      if (typeof record.durationMs === 'number' && record.durationMs >= 0)   s.durationDigest.push(record.durationMs);
      if (typeof record.firstFrameMs === 'number' && record.firstFrameMs >= 0) s.firstFrameDigest.push(record.firstFrameMs);
      if (typeof record.firstTextMs === 'number' && record.firstTextMs >= 0)  s.firstTextDigest.push(record.firstTextMs);
      if (typeof record.firstToolMs === 'number' && record.firstToolMs >= 0)  s.firstToolDigest.push(record.firstToolMs);
      if (typeof record.maxIdleMs === 'number' && record.maxIdleMs >= 0)      s.maxIdleDigest.push(record.maxIdleMs);
      if (typeof record.inputTokens === 'number' && record.inputTokens >= 0)  s.inputTokensDigest.push(record.inputTokens);
      if (typeof record.outputTokens === 'number' && record.outputTokens >= 0) s.outputTokensDigest.push(record.outputTokens);
    }

    // Ring buffer for time-windowed views.
    const compactRecord = {
      ts: Date.now(),
      model: record.model,
      modeKey,
      isStream: !!record.isStream,
      isContinuation: !!record.isContinuation,
      outcome: record.outcome,
      durationMs: record.durationMs ?? null,
      firstFrameMs: record.firstFrameMs ?? null,
      firstTextMs: record.firstTextMs ?? null,
      firstToolMs: record.firstToolMs ?? null,
      maxIdleMs: record.maxIdleMs ?? null,
      retries: record.retries || 0,
      transportErrors: record.transportErrors || 0,
      stalls: record.stalls || 0,
      cascadeDetected: !!record.cascadeDetected,
      toolCount: record.toolCount || 0,
      inputTokens: record.inputTokens || 0,
      outputTokens: record.outputTokens || 0,
    };
    this.recent.push(compactRecord);
    if (this.recent.length > RECENT_RING) {
      this.recent.splice(0, this.recent.length - RECENT_RING);
    }
    this._dirty = true;
  }

  // Connection-level events (one record per pool client open/close).
  // event: 'open' on _openClient; 'close' on c.on('close'/'error'/'goaway')
  // (deduped — only the FIRST close-equivalent for a client emits a record).
  // closeReason: 'error' | 'goaway' | 'closed' | 'idle-recycle' | 'poison' | 'shutdown'
  recordConnectionOpen({ slot }) {
    const sl = this._connSlotKey(slot);
    this.connections.perSlot[sl].opens++;
    this.connections.perSlot[sl].currentClientOpenedAt = Date.now();
    this.connections.totalOpens++;
    this._pushConnEvent({ ts: Date.now(), slot, event: 'open' });
    this._dirty = true;
  }
  recordConnectionClose({ slot, ageMs, streamsServed, streamErrors, closeReason }) {
    const sl = this._connSlotKey(slot);
    this.connections.perSlot[sl].closes++;
    this.connections.perSlot[sl].currentClientOpenedAt = null;
    this.connections.totalCloses++;
    if (typeof ageMs === 'number' && ageMs >= 0) {
      this.connections.lifetimeDigest.push(ageMs);
    }
    if (typeof streamsServed === 'number' && streamsServed >= 0) {
      this.connections.streamsServedDigest.push(streamsServed);
    }
    const reason = closeReason || 'unknown';
    this.connections.closeReasonCounts[reason] = (this.connections.closeReasonCounts[reason] || 0) + 1;
    this._pushConnEvent({
      ts: Date.now(), slot, event: 'close',
      ageMs: ageMs ?? null,
      streamsServed: streamsServed ?? null,
      streamErrors: streamErrors ?? null,
      closeReason: reason,
    });
    this._dirty = true;
  }
  _pushConnEvent(ev) {
    this.connectionEvents.push(ev);
    if (this.connectionEvents.length > CONN_EVENT_RING) {
      this.connectionEvents.splice(0, this.connectionEvents.length - CONN_EVENT_RING);
    }
  }

  // window  — 'lifetime' | 'last1h' | 'last24h' | <ms>
  // model   — optional filter
  // groupBy — 'model' (default) | 'modelMode' (cross-product) | 'mode'
  getStats({ window = 'lifetime', model, groupBy = 'model' } = {}) {
    const filterModel = model || null;
    const isLifetime = window === 'lifetime';

    if (isLifetime) {
      const sourceMap = (groupBy === 'modelMode') ? this.byModelMode : this.byModel;
      const out = { window, groupBy, groups: {} };
      for (const [k, s] of sourceMap.entries()) {
        if (filterModel) {
          const modelPart = (groupBy === 'modelMode') ? k.split('|')[0] : k;
          if (modelPart !== filterModel) continue;
        }
        out.groups[k] = this._summarize(s);
      }
      if (groupBy === 'mode') return this._regroupByMode(out);
      out.totals = this._totals(out.groups);
      return out;
    }

    // Time-windowed: replay the ring. Build digests on the fly.
    const sinceMs = (typeof window === 'number')
      ? window
      : window === 'last1h' ? 60 * 60_000
      : window === 'last24h' ? 24 * 60 * 60_000
      : 60 * 60_000;
    const cutoff = Date.now() - sinceMs;
    const tmp = new Map();
    const keyFn = (r) =>
      (groupBy === 'modelMode') ? `${r.model}|${r.modeKey}`
      : (groupBy === 'mode') ? r.modeKey
      : r.model;

    for (const r of this.recent) {
      if (r.ts < cutoff) continue;
      if (filterModel && r.model !== filterModel) continue;
      const k = keyFn(r);
      let s = tmp.get(k);
      if (!s) { s = _newModelStats(); s.firstSeenAt = r.ts; tmp.set(k, s); }
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
      s.totalToolCalls += r.toolCount || 0;
      if (typeof r.durationMs === 'number')   s.durationDigest.push(r.durationMs);
      if (typeof r.firstFrameMs === 'number') s.firstFrameDigest.push(r.firstFrameMs);
      if (typeof r.firstTextMs === 'number')  s.firstTextDigest.push(r.firstTextMs);
      if (typeof r.firstToolMs === 'number')  s.firstToolDigest.push(r.firstToolMs);
      if (typeof r.maxIdleMs === 'number')    s.maxIdleDigest.push(r.maxIdleMs);
      if (typeof r.inputTokens === 'number')  s.inputTokensDigest.push(r.inputTokens);
      if (typeof r.outputTokens === 'number') s.outputTokensDigest.push(r.outputTokens);
    }
    const out = { window, groupBy, groups: {} };
    for (const [k, s] of tmp.entries()) out.groups[k] = this._summarize(s);
    out.totals = this._totals(out.groups);
    return out;
  }

  // For lifetime + groupBy='mode': aggregate byModelMode by stripping the
  // model prefix. Counters sum trivially; t-digests merge by replaying
  // centroids into a fresh digest.
  _regroupByMode(out) {
    const byMode = new Map();
    for (const [k, s] of this.byModelMode.entries()) {
      const modeKey = k.split('|').slice(1).join('|') || 'unknown';
      let agg = byMode.get(modeKey);
      if (!agg) { agg = _newModelStats(); byMode.set(modeKey, agg); }
      agg.total += s.total;
      agg.success += s.success;
      agg.fail += s.fail;
      agg.retried += s.retried;
      agg.recovered += s.recovered;
      agg.totalRetries += s.totalRetries;
      agg.totalStalls += s.totalStalls;
      agg.totalTransportErrors += s.totalTransportErrors;
      agg.totalCascades += s.totalCascades;
      agg.totalToolCalls += s.totalToolCalls;
      // Merge digests by replaying centroids.
      for (const dKey of ['durationDigest', 'firstFrameDigest', 'firstTextDigest',
                          'firstToolDigest', 'maxIdleDigest',
                          'inputTokensDigest', 'outputTokensDigest']) {
        const arr = s[dKey].toArray();
        if (arr.length) agg[dKey].push_centroid(arr);
      }
    }
    const groups = {};
    for (const [k, s] of byMode.entries()) groups[k] = this._summarize(s);
    return { window: out.window, groupBy: 'mode', groups, totals: this._totals(groups) };
  }

  // Connection-level stats. Includes per-slot churn and lifetime distributions.
  getConnectionStats({ recent = 50 } = {}) {
    return {
      totalOpens: this.connections.totalOpens,
      totalCloses: this.connections.totalCloses,
      currentlyOpen: Math.max(0, this.connections.totalOpens - this.connections.totalCloses),
      closeReasonCounts: { ...this.connections.closeReasonCounts },
      lifetimeMs: {
        p50: _safePercentile(this.connections.lifetimeDigest, 0.5),
        p95: _safePercentile(this.connections.lifetimeDigest, 0.95),
        p99: _safePercentile(this.connections.lifetimeDigest, 0.99),
        n: this.connections.lifetimeDigest.size(),
      },
      streamsPerConnection: {
        p50: _safePercentile(this.connections.streamsServedDigest, 0.5),
        p95: _safePercentile(this.connections.streamsServedDigest, 0.95),
        p99: _safePercentile(this.connections.streamsServedDigest, 0.99),
        n: this.connections.streamsServedDigest.size(),
      },
      perSlot: this._perSlotSnapshot(),
      recentEvents: this.connectionEvents.slice(-recent),
    };
  }

  _perSlotSnapshot() {
    const now = Date.now();
    const out = {};
    for (const [slot, s] of Object.entries(this.connections.perSlot)) {
      out[slot] = {
        opens: s.opens,
        closes: s.closes,
        churn: s.opens - s.closes,
        currentAgeMs: s.currentClientOpenedAt ? (now - s.currentClientOpenedAt) : null,
      };
    }
    return out;
  }

  _summarize(s) {
    const succRate = s.total > 0 ? s.success / s.total : null;
    const firstTryRate = s.total > 0 ? (s.success - s.recovered) / s.total : null;
    const pctile = (d) => ({
      p50: _safePercentile(d, 0.50),
      p95: _safePercentile(d, 0.95),
      p99: _safePercentile(d, 0.99),
      n: d.size(),
    });
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
      totalToolCalls: s.totalToolCalls,
      successRate:  succRate     != null ? Number(succRate.toFixed(4))     : null,
      firstTryRate: firstTryRate != null ? Number(firstTryRate.toFixed(4)) : null,
      durationMs:    pctile(s.durationDigest),
      firstFrameMs:  pctile(s.firstFrameDigest),
      firstTextMs:   pctile(s.firstTextDigest),
      firstToolMs:   pctile(s.firstToolDigest),
      maxIdleMs:     pctile(s.maxIdleDigest),
      inputTokens:   pctile(s.inputTokensDigest),
      outputTokens:  pctile(s.outputTokensDigest),
    };
  }

  _totals(groups) {
    const fields = ['total', 'success', 'fail', 'retried', 'recovered',
      'totalRetries', 'totalStalls', 'totalTransportErrors', 'totalCascades',
      'totalToolCalls'];
    const t = {};
    for (const f of fields) t[f] = 0;
    for (const m of Object.values(groups)) for (const f of fields) t[f] += m[f] || 0;
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
      if (j.schema !== SCHEMA_VERSION) return; // schema mismatch — start fresh
      this.byModel = new Map();
      for (const [m, ms] of Object.entries(j.byModel || {})) {
        this.byModel.set(m, _modelStatsFromJSON(ms));
      }
      this.byModelMode = new Map();
      for (const [k, ms] of Object.entries(j.byModelMode || {})) {
        this.byModelMode.set(k, _modelStatsFromJSON(ms));
      }
      if (Array.isArray(j.recent)) {
        this.recent = j.recent.slice(-RECENT_RING);
      }
      if (j.connections) {
        this.connections.totalOpens = j.connections.totalOpens || 0;
        this.connections.totalCloses = j.connections.totalCloses || 0;
        this.connections.closeReasonCounts = j.connections.closeReasonCounts || {};
        this.connections.lifetimeDigest = _digestFromJSON(j.connections.lifetimeDigest);
        this.connections.streamsServedDigest = _digestFromJSON(j.connections.streamsServedDigest);
        this.connections.perSlot = j.connections.perSlot || {};
        // Drop currentClientOpenedAt — those clients don't survive restarts.
        for (const k of Object.keys(this.connections.perSlot)) {
          this.connections.perSlot[k].currentClientOpenedAt = null;
        }
      }
      if (Array.isArray(j.connectionEvents)) {
        this.connectionEvents = j.connectionEvents.slice(-CONN_EVENT_RING);
      }
    } catch (e) {
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
      byModelMode: {},
      recent: this.recent,
      connections: {
        totalOpens: this.connections.totalOpens,
        totalCloses: this.connections.totalCloses,
        closeReasonCounts: this.connections.closeReasonCounts,
        lifetimeDigest: _digestToJSON(this.connections.lifetimeDigest),
        streamsServedDigest: _digestToJSON(this.connections.streamsServedDigest),
        perSlot: this.connections.perSlot,
      },
      connectionEvents: this.connectionEvents,
    };
    for (const [m, s] of this.byModel.entries())     obj.byModel[m] = _modelStatsToJSON(s);
    for (const [k, s] of this.byModelMode.entries()) obj.byModelMode[k] = _modelStatsToJSON(s);
    try {
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
    this.byModelMode.clear();
    this.recent = [];
    this.connectionEvents = [];
    this.connections = {
      lifetimeDigest: _newDigest(),
      streamsServedDigest: _newDigest(),
      closeReasonCounts: {},
      totalOpens: 0,
      totalCloses: 0,
      perSlot: {},
    };
    this._dirty = false;
  }
}

const _instance = new RuntimeStats();

module.exports = {
  recordTurnEnd:           (r) => _instance.recordTurnEnd(r),
  recordConnectionOpen:    (r) => _instance.recordConnectionOpen(r),
  recordConnectionClose:   (r) => _instance.recordConnectionClose(r),
  getStats:                (opts) => _instance.getStats(opts),
  getConnectionStats:      (opts) => _instance.getConnectionStats(opts),
  startPersistence:        () => _instance.startPersistence(),
  saveNow:                 () => _instance._saveToDisk(),
  _resetForTests:          () => _instance._resetForTests(),
  // For periodic-log helper to access cheaply:
  _instance,
  modeKeyOf,
  // Constants exported for tests
  RECENT_RING,
  CONN_EVENT_RING,
  SCHEMA_VERSION,
};
