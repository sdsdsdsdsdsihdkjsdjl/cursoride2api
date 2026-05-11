# Debugging methodology — live-monitoring proxy turns

Recipe for running the proxy and getting one notification per turn lifecycle event. Most useful when reproducing stalls, slowness, or "stuck" sessions: silence in the notification stream is itself a signal that the upstream is hung.

## TL;DR

```bash
# 1. Start proxy in background, redirect both streams to a log file:
PORT=4141 node server.js > /tmp/proxy.log 2>&1 &
PROXY_PID=$!

# 2. Tail-and-filter the log; each matched line becomes one event.
#    The grep alternation MUST cover failure modes too — silence is not success.
tail -f /tmp/proxy.log | grep -E --line-buffered \
  '📨|✅ turn ended|✅ stream done|✅ done|❌|⚠️|🔄 continuation|Upstream stalled|pool slot|RESOURCE_EXHAUSTED|429|GOAWAY|REFUSED_STREAM|INTERNAL_ERROR'

# 3. When done:
kill $PROXY_PID
```

When using Claude Code, `tail -f ... | grep --line-buffered ...` goes inside a Monitor tool call so each matched line surfaces as a chat notification. Set `persistent: true` for session-length watches.

## Why this works

- **One event per significant moment.** The proxy logs each turn boundary (`📨` arrival, `✅` end), each error (`❌`), and each retry / pool-state change (`🔄`, `pool slot`). Filtering on those lines means you get one notification per real event, not per log byte.
- **Silence is a signal.** When upstream Cursor hangs, the proxy emits no new events. The absence of `✅ turn ended` for 60+ seconds after a `📨` line means a stall is in progress — visible at a glance through the gap in notifications. (We tuned the stall watchdog to 60 s for this reason — see DEVLOG.)
- **Decoupled from the proxy's lifecycle.** The proxy can crash, restart, or be killed without breaking the watcher: the watcher just stops getting events. You don't need to coordinate the two.

## The grep alternation: what to include

Every entry covers either a turn lifecycle moment or a failure signature. **Drop any of these and you'll get false silence on a real failure.**

| Pattern | What it means |
|---|---|
| `📨` | A new turn arrived (`/v1/messages` or `/v1/chat/completions`). One per request. |
| `✅ turn ended` | Anthropic-path turn finished cleanly (with token counts). |
| `✅ stream done` / `✅ done` | OpenAI-path turn finished cleanly. |
| `❌` | Any error path. Always include this. |
| `⚠️` | Warning (e.g. bridge cache miss). |
| `🔄 continuation` | Continuation of an existing turn (tool_result follow-up). |
| `Upstream stalled` | Stall watchdog tripped — 60 s with no useful frame from Cursor. |
| `pool slot` | Pool slot poisoned / evicted (cascade signal). |
| `RESOURCE_EXHAUSTED` / `429` | Rate limit. With the new TokenPool, the affected token is parked 60 s. |
| `GOAWAY` / `REFUSED_STREAM` / `INTERNAL_ERROR` | H2 transport hiccup that triggered a retry. |

Add to the alternation when you're chasing a specific hypothesis. Remove only after you're done — broad coverage means a few extra notifications during a clean run, but it means you'll never miss a crashloop or a hung process.

## Variations

### Run from a chat session (Claude Code)

Use `Bash` with `run_in_background: true` to start the server, then `Monitor` for the tail. The Monitor tool's stdout is the event stream:

```
Bash(command="PORT=4141 node server.js > /tmp/proxy.log 2>&1", run_in_background=true)
Monitor(
  command="tail -f /tmp/proxy.log | grep -E --line-buffered '📨|✅|❌|Upstream stalled|pool slot|429|GOAWAY'",
  description="proxy turn lifecycle",
  persistent=true,
  timeout_ms=3600000,
)
```

`persistent: true` keeps the watcher alive for the rest of the session. Stop it with `TaskStop` when done.

### Watch a specific endpoint

Filter further by adding `(Anthropic)` to the alternation to only see `/v1/messages` traffic, or `OpenAI` for `/v1/chat/completions`:

```bash
... | grep -E --line-buffered '(Anthropic).*📨|✅ turn ended|❌'
```

### Watch the token pool's health in real time

```bash
watch -n 2 'curl -s http://localhost:4141/health | jq .tokens'
```

Combine with the log monitor: log gives you turn events, `/health` gives you cumulative counters and parking state.

### Watch live in-flight bridges — is this turn thinking, or stuck?

`/stats/inflight` exposes the live state of every active bridge — the question "right now, is upstream silent or making progress?" gets a one-curl answer.

```bash
watch -n 2 'curl -s http://localhost:4141/stats/inflight | jq ".bridges[0]"'
```

Decision rule reading the fields:

- `thinkingDeltaCount` or `textDeltaCount` rising between polls → model is producing, wait
- both flat **and** `bytesInSinceLastUsefulFrame` ≈ 0 → only heartbeats are flowing, upstream is silent
- `willTripStallInMs` shows how long until the watchdog will declare a stall and emit the SSE error / retry

### Pull per-model latency distributions to retune thresholds

```bash
# All models, lifetime aggregates
curl -s http://localhost:4141/stats | jq '.groups'

# Mode breakdown for the last hour
curl -s 'http://localhost:4141/stats?window=last1h&groupBy=modelMode' | jq '.groups'

# Connection lifecycle: who's churning, why
curl -s http://localhost:4141/stats/connections | jq '{closeReasonCounts, lifetimeMs, streamsPerConnection, perSlot}'
```

The point of these endpoints is that `src/stall-thresholds.js` baselines were derived from intuition; with a week of real `firstFrameMs.p99` and `maxIdleMs.p99` data per model, you can rebuild the formula from evidence.

### Get a per-request timing breakdown

The proxy already logs a structured timing line on each turn end:

```
✅ turn ended | in=... out=... | total=Xms first_byte=Yms first_text=Zms
```

Search the log for `total=` lines if you want a histogram of turn durations.

## Stopping cleanly

```bash
kill $PROXY_PID            # if you have the PID
pkill -f 'node server.js'  # otherwise

# In Claude Code:
TaskStop(task_id=...)      # stops the Monitor
```

The proxy ignores SIGINT gracefully (logs `Bye!`); SIGTERM is also clean. Avoid SIGKILL unless it's truly stuck — leaks open H2 streams.

## Common patterns we caught with this

- **17-minute hangs**: `📨` followed by 17 minutes of silence, then a final `❌`. Led to the stall watchdog + GOAWAY-aware retry (commits `7de6ea1`, `e8ce783`).
- **LB cascade**: three `pool slot #N hit ... errors` events in 300 ms. Led to `_drainingClients` WeakSet + 100/250/750 ms backoff (commit `cf4367e`).
- **`/context` showing 0**: `✅ turn ended | in=0` repeatedly on tool_use turns. Led to bridge `getStats()` + `inputTokens` in streaming `message_delta` (commit `9231114`).
- **Stale `claude-opus-4-7-max` rewrites**: `📨 ... claude-opus-4-7-max → claude-opus-4-7-thinking-max` — the rewrite was visible in the very first log line per request, instantly revealing the bug. Led to adaptive-thinking-preserves-input fix (commit `8b03145`).

In every case the methodology let us catch the problem either as a notification gap (stall) or as an unexpected line content (rewrite). Without it we'd have been re-running with `--print` each time and squinting at scrollback.
