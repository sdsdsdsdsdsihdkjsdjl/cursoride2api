# DEVLOG — Anthropic API + Tool-Use Support

A working notebook of what we learned reverse-engineering Cursor's `agent.v1.AgentService/Run` enough to bridge the Anthropic Messages API (with full tool-use round-trip) on top of it. Written after the work was done; if you are continuing this you should be able to skip several days of dead ends by reading this first.

## TL;DR

1. The proxy speaks `application/connect+proto` (binary protobuf). Connect+JSON works for simple chat but breaks tool registration silently.
2. Cursor's upstream Anthropic provider rejects requests where any MCP tool name collides with Cursor's built-in agent-mode tool surface (14 confirmed names: `Read`, `Write`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Shell`, `Delete`, `Task`, `TodoWrite`, `AskQuestion`, `ListMcpResources`, `ReadLints`, `SwitchMode`). **Always prefix the wire-level `McpToolDefinition.name` with `mcp_`** while leaving `tool_name` unchanged.
3. Cursor's error envelope hides the real cause inside `error.details[].debug.details.detail`. Top-level `error.message` is often the literal string `"Error"`. Walk the trailer.
4. The Cursor stream stays paused after emitting `mcpArgs` — it will NOT fire `turnEnded` until we send `mcpResult`. So when bridging to Anthropic semantics we have to *synthesize* `stop_reason=tool_use` ourselves (we use a 250 ms debounce to batch parallel tool calls).
5. Cursor's KV blob channel must be ACKed (both `setBlobArgs` → `setBlobResult: {}` and `getBlobArgs` → `getBlobResult` with whatever we cached). Without this the model just sits there idle.
6. Verified end-to-end through `claude -p` with `claude-opus-4-7`, `claude-sonnet-4-6`, and `claude-haiku-4-5`. Tool-use round-trip works.
7. `McpToolDefinition.input_schema` and `McpArgs.args` (map values) changed from `bytes` to `google.protobuf.Value` between Cursor proto versions. The proxy now passes a `Value` *object* on encode and unwraps `Value` *objects* on decode (instead of relying on `bytes`), which works under both definitions. See "Vendored proto regen" entry for the silent-drop failure mode and "decodeMcpArgs" entry for the inbound mirror.
8. `convKey`/`bridgeKey` derive from claude-code's `x-claude-code-session-id` header (with `firstUserText` + `toolHash` salt) when present, so parallel claude-code sessions with identical prompts don't alias their bridges, and a session's WebSearch/Task subagent doesn't collide with its parent. Fallback to the older circumstantial-hash scheme for non-claude-code callers. See "convKey collision fix" + "convKey v2 subagent regression" entries.
9. **WebFetch through the proxy works end-to-end.** **WebSearch does not** — claude-code's WebSearch is an Anthropic-server-side tool that bypasses the model's tool-use path; with `ANTHROPIC_BASE_URL=our-proxy` it has no reachable backend. Use an MCP web-search server (Brave/SerpAPI/etc.) if you need real search through this stack.

---

## Architecture

```
Anthropic client                 Proxy (this repo)                   Cursor
(Claude Code,                                                        api2.cursor.sh
 Anthropic SDK,
 opencode)
       │                                  │                                │
       │── POST /v1/messages ────────────>│                                │
       │   (Anthropic format)             │── runRequest (proto bytes) ───>│
       │                                  │   over HTTP/2 + connect+proto  │
       │                                  │<── execServerMessage ──────────│
       │                                  │   (requestContextArgs)         │
       │                                  │── execClientMessage ──────────>│
       │                                  │   (requestContextResult: tools)│
       │                                  │<── kvServerMessage ────────────│
       │                                  │   (setBlobArgs: system prompt) │
       │                                  │── kvClientMessage ────────────>│
       │                                  │   (setBlobResult: {})          │
       │                                  │<── interactionUpdate ──────────│
       │                                  │   (textDelta / thinkingDelta)  │
       │                                  │<── execServerMessage ──────────│
       │                                  │   (mcpArgs: TOOL CALL)         │
       │<── tool_use block + ──────────────│   (proxy synthesizes          │
       │   stop_reason=tool_use            │    stop_reason after 250 ms)  │
       │                                  │   STREAM STAYS OPEN            │
       │── POST /v1/messages ─────────────>│                                │
       │   (with tool_result blocks)       │── execClientMessage ─────────>│
       │                                  │   (mcpResult)                  │
       │                                  │<── interactionUpdate ──────────│
       │                                  │   (final text)                 │
       │                                  │<── interactionUpdate ──────────│
       │                                  │   (turnEnded)                  │
       │<── stop_reason=end_turn ──────────│                                │
```

### Files

| File | Purpose |
|------|---------|
| `server.js` | Express routes, conversation/bridge cache, `/v1/messages` orchestration |
| `src/cursor-client.js` | Original simpler client for `/v1/chat/completions` (untouched) |
| `src/cursor-agent.js` | Connect+proto client used by `/v1/messages`. Frame parser, tool encoding, KV/exec dispatch, stream lifecycle |
| `src/anthropic-converter.js` | Anthropic SSE event builders, message parsing, response shaping |
| `src/anthropic-tools.js` | Anthropic tools → MCP tool descriptors. `TOOL_INCLUDE`, `TOOL_LIMIT`, `TOOL_DESC_LIMIT`, `TOOL_SCHEMA_TRIM_BYTES` |
| `src/proto/agent_pb.mjs` | Vendored compiled protobuf schemas (~3250 lines) from `ephraimduncan/opencode-cursor` |
| `src/config.js` | Model name mapping (Anthropic ↔ Cursor) |

---

## Key wire-format facts

### Content-Type matters

`application/connect+json` works for plain chat but **silently fails for tool registration**: Cursor's tool dispatcher only picks up tools when the request is `application/connect+proto` (binary). We spent half a day chasing "why does the model not use my tools" before this clicked.

### Protobuf encoding for `inputSchema`

`McpToolDefinition.input_schema` is `bytes` in the proto. The bytes must be a `google.protobuf.Value` proto-encoded blob (not a JSON-stringified schema, not raw bytes of JSON text). We use:

```js
const inputSchema = toBinary(wkt.ValueSchema, fromJson(wkt.ValueSchema, jsonSchemaObject));
```

### The `name` vs `tool_name` distinction (critical)

`McpToolDefinition` has two name-ish fields:
- `name` → goes into Cursor's wire-level tool list, shown to the upstream Anthropic provider
- `tool_name` → echoed back in `mcpArgs.tool_name` when the model calls it

Cursor IDE's MCP integration namespaces server tools as `mcp__<server>__<tool>`, so the IDE never collides with Cursor's built-in surface. **We do collide** because Anthropic SDK clients pass tools with names like `Read`, `Write`, `Bash`, `TodoWrite`, etc. Without prefixing, the upstream provider sees duplicates and returns `ERROR_PROVIDER_ERROR`.

Cursor's full native tool list isn't documented anywhere we found. Cross-referencing the proto schema (`agent_v1.proto` lines 3855-3893 list 36 `*ToolCall` messages), the compiled `agent_pb.mjs`, the reference proxy `opencode-cursor`, and direct probing produced this empirical list as of May 2026:

#### Blocked names (14)

These return `ERROR_PROVIDER_ERROR resource_exhausted` when registered as an MCP tool without the `mcp_` prefix:

```
Read         Write          Grep             Glob
WebFetch     WebSearch      Shell            Delete
Task         TodoWrite      AskQuestion      ListMcpResources
ReadLints    SwitchMode
```

#### Pass-through (sample of ~70 verified non-colliding)

```
Apply         ApplyAgentDiff   Bash            BackgroundShell
CommitChanges Compose          ComputerUse     Create
CreatePlan    CreatePR         Curl            Diagnostics
Edit          EditFile         ExaFetch        ExaSearch
ExecuteHook   Fetch            Find            Format
Generate      GenerateImage    GetBlob         GetDefinition
GlobTool      HTTP             Lint            Ls
Lookup        Mcp              MultiEdit       NotebookEdit
NotebookRead  OpenBrowser      OpenFile        Patch
Plan          Quack            Reflect         Refactor
ReadMcpResource  ReadTodos     ReadTool        RecordScreen
RemoveFile    RenameFile       ReportBugfixResults  RequestContext
RunCell       RunCommand       RunInTerminal   RunTerminal
Search        SearchFiles      SearchSymbols   SemSearch
SemSearchTool SetBlob          SetupVmEnvironment   StartGrindExecution
StartGrindPlanning   Test      Todo            TodoRead
TruncatedToolCall    Update    UpdateTodos     WriteShellStdin
xyzzy         (plus all-lowercase variants of every blocked name)
```

#### Pattern observations

- **Whole-string PascalCase match.** `read`, `write`, `grep`, `glob`, `webfetch`, `shell`, `delete`, `task`, `todowrite` (lowercase) all pass. `Bash` passes (Cursor uses `Shell`). `ReadTool`, `GlobTool` pass (suffixed forms).
- **Anthropic-reserved names pass.** `bash_20250124`, `text_editor_20250728`, `computer`, `web_search`, `web_fetch` all go through. So the blocklist isn't from the Anthropic API side (whose tool regex is just `^[a-zA-Z0-9_-]{1,64}$` with no reservations).
- **Most proto-defined tools DON'T block.** Of 36 `*ToolCall` messages in the proto, only 14 are actually reserved upstream. Cursor's IDE seems to surface only a subset to the upstream Anthropic provider.

#### What this means for the proxy

Always prefix every MCP tool's wire `name` field with `mcp_` and leave `tool_name` unchanged. The blocklist above is documentation only — the proxy doesn't consult it. The reference `opencode-cursor` doesn't prefix and would hit this on any of the 14 names if a client happens to use one.

If you ever need to disable prefixing (e.g., to test a name directly), the toggle is in `cursor-agent.js`:

```js
const wireName = t.name.startsWith(MCP_NAME_PREFIX) ? t.name : MCP_NAME_PREFIX + t.name;
```

Fix in `cursor-agent.js`:

```js
const MCP_NAME_PREFIX = 'mcp_';
const wireName = t.name.startsWith(MCP_NAME_PREFIX) ? t.name : MCP_NAME_PREFIX + t.name;
out.push(create(McpToolDefinitionSchema, {
  name: wireName,                 // wire-level, mcp_-prefixed
  toolName: t.toolName || t.name, // echoed back, original name
  ...
}));
```

When Cursor sends `mcpArgs` back, `tool_name` is `Read` (the original) so our handler can map it back to the client's expected tool name without a translation table.

### Reject native tool calls properly

The model first tries Cursor's *native* tools (`readArgs`, `writeArgs`, `shellArgs`, etc.). We respond with **typed rejections**, NOT generic errors. Each tool has its own result type and rejection variant:

| `*Args` | Result field | Rejection shape |
|---------|--------------|-----------------|
| `readArgs` | `readResult` | `rejected: { path, reason }` |
| `lsArgs` | `lsResult` | `rejected: { path, reason }` |
| `writeArgs` | `writeResult` | `rejected: { path, reason }` |
| `deleteArgs` | `deleteResult` | `rejected: { path, reason }` |
| `shellArgs` | `shellResult` | `rejected: { command, workingDirectory, reason, isReadonly: false }` |
| `shellStreamArgs` | **`shellStream`** (NOT shellResult!) | `rejected: { command, workingDirectory, reason, isReadonly: false }` |
| `backgroundShellSpawnArgs` | `backgroundShellSpawnResult` | `rejected: { command, workingDirectory, reason, isReadonly }` |
| `grepArgs` | `grepResult` | `error: { error }` (note: `error`, not `rejected`) |
| `fetchArgs` | `fetchResult` | `error: { url, error }` |
| `writeShellStdinArgs` | `writeShellStdinResult` | `error: { error }` |
| `diagnosticsArgs` | `diagnosticsResult` | `{ diagnostics: [] }` (silent empty) |
| `requestContextArgs` | `requestContextResult` | `success: { requestContext: { tools, env, ... } }` |

Sending the wrong rejection shape (e.g., `shellResult.rejected` for `shellStreamArgs`) causes the model to silently hang.

### `max_mode` flag vs `-max` suffix in model id

These are **orthogonal**:

- **`-max` suffix**: part of the `model_id` itself, indicates reasoning-effort tier. `GetUsableModels` returns variants like `claude-opus-4-7-low/medium/high/xhigh/max`. We map `claude-opus-4-7` → `claude-opus-4-7-thinking-max` (max thinking effort).
- **`max_mode` boolean**: a billing flag in `ModelDetails.max_mode = 7` and `RequestedModel.max_mode = 2`. Different concept (Cursor's "1M-context Max Mode" billing tier). We default this OFF; auto-enabling it on small accounts triggered `ERROR_PROVIDER_ERROR`.

Don't conflate them.

### KV blob handshake

Cursor uses `kvServerMessage.setBlobArgs` to push pieces of conversation state (system prompt, user context) onto our side. **We must ACK with `setBlobResult: {}`** — without the ACK the model stalls. We also handle `getBlobArgs` by returning the cached blob (or empty if we don't have it).

```js
if (kv.setBlobArgs) {
  blobStore.set(kv.setBlobArgs.blobId, kv.setBlobArgs.blobData);
  writeFrame({ kvClientMessage: { id: kv.id, setBlobResult: {} } });
}
```

### Stream lifecycle across HTTP requests

For tool-use to work:

1. The H2 stream to Cursor opens on the first `/v1/messages` request.
2. When the model emits `mcpArgs`, the proxy must NOT close the stream — Cursor is paused waiting for our `mcpResult`.
3. The proxy returns to the client with `stop_reason: tool_use` immediately (we use a 250 ms debounce so parallel tool calls in the same turn batch into one Anthropic response).
4. The client (Claude Code) executes the tool locally and POSTs `/v1/messages` again with `tool_result` blocks.
5. The proxy's bridge cache (keyed by `bridgeKey = sha256("bridge:" + modelId + ":" + firstUserText.slice(0,200))`) finds the open stream, sends `execClientMessage` with `mcpResult`, and continues reading.
6. When the model finishes (`turnEnded`), we close the bridge.

Heartbeats (`ClientHeartbeat` proto) every 5s keep the connection alive while we wait between turns.

### Cursor synthesizes its own system prompt

When you send a request, Cursor sends back `setBlobArgs` containing what looks like `{"role": "system", "content": "You are an AI coding assistant powered by Claude..."}`. This is Cursor's own system prompt, injected regardless of what your client passes in.

This is what makes opencode integration awkward. Cursor's prompt tells the model "you are Cursor's assistant", which can override or confuse opencode's instructions. Claude Code's framing (`CLAUDE.md` style + tool descriptions) coexists better.

---

## The error message decoding

This single bug masked everything else for hours.

The Connect end-stream trailer for an error looks like:

```json
{
  "error": {
    "code": "resource_exhausted",
    "message": "Error",
    "details": [{
      "type": "aiserver.v1.ErrorDetails",
      "debug": {
        "error": "ERROR_PROVIDER_ERROR",
        "details": {
          "title": "Provider Error",
          "detail": "We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.",
          "isRetryable": false
        }
      }
    }]
  }
}
```

Top-level `message` is the literal string `"Error"`. Useful info is in `details[].debug.details.detail` and `details[].debug.error`. Walk the array, surface the first useful detail string. Otherwise every diagnosis is a guessing game.

`ERROR_PROVIDER_ERROR` itself has multiple causes, including:
- Tool-name collision with native Cursor tools (the big one)
- Account doesn't have agent-mode quota for the chosen model
- Aggregate tool-schema bytes exceed Cursor's per-request budget (~30 KB after trimming)
- Model temporarily unavailable upstream

---

## Debug logging

Set `DEBUG_LOG=1` (or `DEBUG_LOG=verbose`) to write structured JSON logs to a file. One line per event, easy to grep / `jq`. Useful while debugging — captures errors with full context (request id, model, conversation/bridge keys, body summary, decoded Cursor wire errors).

```bash
DEBUG_LOG=1 PORT=4141 npm start
# logs at ./logs/server-YYYY-MM-DD.log

DEBUG_LOG=verbose PORT=4141 npm start
# also includes the full request body and tool-call args
```

Events captured:

| event | level | when |
|-------|-------|------|
| `request_received` | info | every `/v1/messages` request after validation |
| `tool_call` | info | every MCP tool call routed back to the client |
| `turn_ended` | info | every successful turn (with tokens + stop_reason) |
| `cursor_upstream_error` | error | every Cursor wire error (with the decoded `error.details[].debug.details.detail` chain) |
| `proxy_error` | error | proxy-side exceptions |
| `rejected_request` | warn | malformed body (e.g. missing `messages`) |
| `no_tokens_available` | error | `token.json` empty / out of valid tokens |
| `continuation_cache_miss` | warn | bridge cache evicted before client posted tool_result |

Each entry includes a per-request `request_id` (8-char UUID) so you can grep all events for a single request:

```bash
grep '"request_id":"abc12345"' logs/server-*.log | jq .
```

Override the directory with `DEBUG_LOG_DIR=/var/log/cursoride2api`.

---

## Request preprocessing & classification (ported from copilot-api)

A user-prompt-vs-tool-continuation classification problem distinct from the wire-format work. Cursor bills per BiDi `AgentService.Run` stream — one stream = one fast request, regardless of how many tool round-trips happen inside. Our `activeBridges` cache already keeps the same H2 stream alive across `/v1/messages` continuations, so this is largely correct for free.

But there are edge cases where Claude Code or OpenCode legitimately starts a *new* user turn that we'd rather not bill at full price. Ported from [`caozhiyuan/copilot-api`'s preprocess](https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/messages/preprocess.ts):

- **Compaction detection** — Claude Code's `/compact` and OpenCode's anchor-context summarizer emit a recognizable system prompt:
  - `system` starts with *"You are a helpful AI assistant tasked with summarizing conversations"* (Claude Code) or *"You are an anchored context summarization assistant for coding sessions."* (OpenCode), OR
  - last user message contains the `CRITICAL: Respond with TEXT ONLY` guard + the `Your task is to create a detailed summary` prompt + a `Pending Tasks:` / `Current Work:` section.

  Detected as `COMPACT_REQUEST` (1) → routed to `SMALL_MODEL` (default `claude-sonnet-4-6`). Compaction summarization doesn't need full Opus reasoning; saves a fast request × N concurrent compactions.

- **Compact auto-continue** — the prompt that lands AFTER a compaction summary, when the model resumes. Detected as `COMPACT_AUTO_CONTINUE` (2) but **not downgraded** (the model needs full reasoning to keep coding) — only logged, in case we want to special-case it later.

- **Subagent marker** — Claude Code's `Agent` tool and OpenCode's sub-task launcher inject `<system-reminder>__SUBAGENT_MARKER__{"session_id":"...","agent_id":"...","agent_type":"..."}</system-reminder>` into the first user message of every subagent turn (the [copilot-api Claude Code plugin](https://github.com/caozhiyuan/copilot-api) does this; you'd install the same plugin to use it with us). Detected via `detectSubagentMarker()`. Default behavior: log the marker, keep the requested model. Set `SUBAGENT_USE_SMALL_MODEL=1` to downgrade subagents to `SMALL_MODEL` (good for cheap subtasks like web-search agents; not great if subagents do real coding).

- **IDE tool sanitization** — Claude Code injects `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` MCP tools when its IDE plugin is active, even on requests that don't need them. `mcp__ide__executeCode` (when not deferred) is dropped before forwarding so warmup/no-tool requests stay tool-less.

**Env knobs**

| Env var | Default | Purpose |
|---------|---------|---------|
| `SMALL_MODEL` | `claude-sonnet-4-6` | Used for compaction + (optionally) subagent + haiku-warmup-when-tools |
| `SUBAGENT_USE_SMALL_MODEL` | unset | `1`/`true`/`yes` → also route subagent traffic to `SMALL_MODEL` |

Source: `src/preprocess.js`. Server log surfaces the routing reason on each request:

```
📨 (Anthropic) claude-opus-4-7 → claude-4.6-sonnet-medium | ... | compact-request
📨 (Anthropic) claude-opus-4-7 → claude-opus-4-7-thinking-max | ... | subagent passthrough (explore)
```

What this is NOT: **this does not reduce HTTP requests**. Claude Code still sends N+1 requests per user turn (Anthropic protocol shape). What it does is route the right *kind* of request to the right model so we're not paying full Opus for a 200-token summarization step. See "Cursor IDE has no N+1 problem" elsewhere in this doc for the architectural reason.

---

## Tool-budget knobs

Claude Code's stock 49 tools (~150 KB raw) work fine through the proxy now — defaults trim them under Cursor's per-request schema budget automatically. `src/anthropic-tools.js` exposes these as escape hatches for unusual cases:

| Env var | Default | Purpose |
|---------|---------|---------|
| `TOOL_INCLUDE` | (unset) | Allowlist of tool names. Only these are forwarded |
| `TOOL_LIMIT` | `0` (unlimited) | Hard cap on tool count after `TOOL_INCLUDE` |
| `TOOL_DESC_LIMIT` | `600` chars | Truncate `description` field on each tool |
| `TOOL_SCHEMA_TRIM_BYTES` | `30000` | If aggregate schema bytes exceed this, strip `properties[].description` from JSON schemas |

Defaults work for stock Claude Code; only set these if a specific client overflows the budget.

---

## Verified working configurations

After the always-prefix fix, **no env vars are needed** for Claude Code's full 49-tool set:

```bash
# Server — just start it normally
PORT=4141 npm start

# Client — Claude Code
ANTHROPIC_BASE_URL=http://localhost:4141 claude -p \
  "Read test-data.txt and quote it" --model claude-opus-4-7
# → opus calls Read → claude code executes → opus quotes the actual file content

# Verified models with tools (full claude -p tool-use round-trip):
#   claude-opus-4-7    → claude-opus-4-7-thinking-max
#   claude-sonnet-4-6  → claude-4.6-sonnet-medium
#   claude-haiku-4-5   → claude-4.6-sonnet-medium  (auto-upgrade when tools present)
#   claude-haiku-4-5   → composer-2-fast           (warmup ping, no tools — keeps cheap)
```

Optional knobs (only needed if you have unusually large tool sets that exceed Cursor's per-request schema budget):

| Env var | Default | Purpose |
|---------|---------|---------|
| `TOOL_INCLUDE` | (unset) | Allowlist by tool name |
| `TOOL_LIMIT` | `0` (unlimited) | Hard cap on tool count |
| `TOOL_DESC_LIMIT` | `600` chars | Truncate `description` field |
| `TOOL_SCHEMA_TRIM_BYTES` | `30000` | Strip `properties[].description` when aggregate exceeds |

For the OpenAI-compatible endpoint (no tool-use), the original `cursor-client.js` path remains:

```bash
curl http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'
```

---

## Dead ends (so you don't repeat them)

- **Switching `:authority` or `:scheme`**: doesn't change anything.
- **Setting `x-ghost-mode`, `x-cursor-client-type=ide`, `x-cursor-client-arch`**: no effect on the provider error.
- **Bumping `x-cursor-client-version` from 2.6.20 to 3.2.0**: no effect.
- **Sending `runRequest.mcpTools` in addition to `RequestContext.tools`**: doubles the bytes for no benefit; the working reference (`opencode-cursor`) uses only `RequestContext.tools`.
- **Auto-enabling `max_mode` when ≥ N tools registered**: triggers `ERROR_PROVIDER_ERROR` on accounts where the chosen model isn't entitled to max-mode. Keep it opt-in.
- **Trying to truncate the request below "70 KB" thinking it was a size limit**: it never was. The size correlation was a coincidence — the real cause was tool-name collisions.
- **Setting `subagent_type_name` or `agent_mode` in the runRequest**: no effect on the provider error.
- **Changing `displayNameShort` or `aliases` on `ModelDetails`**: no effect.

---

## References

The full catalog of every Cursor RE repo and material we've consulted (including the ones we deliberately skipped, the local `/tmp/` working copies, and the broader 29-repo landscape from the upstream survey) lives at [REFERENCES.md](REFERENCES.md). The lists below are the per-purpose subset relevant to this dev log; see the consolidated file for the wider picture.

### Primary references (foundational)

- [`ephraimduncan/opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor) — the working TypeScript reference proxy. Read its `src/proxy.ts` if anything here is unclear.
- [`burpheart/cursor-tap`](https://github.com/burpheart/cursor-tap) — packet-capture-based reverse engineering, source of the proto definitions in `cursor_proto/agent_v1.proto` (4345 lines).
- [Connect protocol spec](https://connectrpc.com/docs/protocol) — frame format, end-stream trailers.
- [`@bufbuild/protobuf` docs](https://github.com/bufbuild/protobuf-es) — runtime we use for proto encode/decode.
- This repo's `Cursor IDE API 逆向工程文档.md` — older Chinese-language reverse engineering notes (predates the connect+proto migration but still useful for non-tool flows).

### Secondary references (cross-checked; see "Cross-referencing with other Cursor RE projects" above for what we adopted/rejected)

- [`JJDTrump/cursor-reverse-engineering`](https://github.com/JJDTrump/cursor-reverse-engineering) — Cursor IDE v3.2.11 deep RE (Chinese). Single-README write-up of gRPC services, headers, ModelDetails. Several claims are stale vs. the current `agent.v1.AgentService` we target; treat dated material with skepticism.
- [`anyrobert/cursor-api-proxy`](https://github.com/anyrobert/cursor-api-proxy) — most polished CLI-wrapping proxy. Origin of the health-aware `TokenPool` design we ported. Different architecture (wraps the `cursor-agent` CLI binary).
- [`JiuZ-Chn/Cursor-To-OpenAI`](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) — closest peer (also backend-direct). Source of the dated-variant regex idea and the fuller header survey. Includes a PKCE login flow we have not yet ported.
- [`unkn0wncode/extract-cursor-protos`](https://github.com/unkn0wncode/extract-cursor-protos) — extracts the full `aiserver.v1` + `agent.v1` proto registry from Cursor binaries. Useful catalog when tracking down a wire-format question; we keep a hand-curated subset to avoid the bulk.
- [`yokingma/OpenCursor`](https://github.com/yokingma/OpenCursor) — small TS proxy; documents `WorkosCursorSessionToken` cookie sourcing. Mostly redundant with JiuZ-Chn.
- [`leeguooooo/agent-cli-to-api`](https://github.com/leeguooooo/agent-cli-to-api) — multi-CLI gateway (cursor-agent / codex / claude / gemini). Useful for comparing how each CLI's protocol differs.
- [`Azhi-ss/cursorcli2api`](https://github.com/Azhi-ss/cursorcli2api), [`tageecc/cursor-agent-api-proxy`](https://github.com/tageecc/cursor-agent-api-proxy) — smaller CLI-wrapping experiments.

---

## On `composer-2-fast` and Claude Haiku

Cursor has **no Claude Haiku model** — `/v1/models` returns 0 matches for "haiku". The smallest real Claude on Cursor is `claude-4.5-sonnet`. We previously mapped:

```
'claude-haiku-4-5':       'composer-2-fast'  // ← this is NOT Claude Haiku
'claude-haiku-4-5-20251001': 'composer-2-fast'
'claude-3-5-haiku-*':     'composer-2-fast'
```

[`composer-2-fast` is Cursor's own Composer 2 in fast variant](https://cursor.com/blog/composer-2) — built on Kimi K2.5 (Moonshot AI's MoE model) with continued pre-training and RL. It's cheap and fast but it's NOT Claude.

This matters: when a "haiku" request reaches the proxy, the user expects Claude tokenizer/grammar/billing. We were silently substituting Kimi K2.5. Earlier "tool use works for haiku" tests were actually proving Kimi+Cursor's MCP layer works — telling us nothing about real Claude Haiku.

**Current strategy** (after the fix):
- Bare `claude-haiku-*` requests **with no tools** (Claude Code's startup warmup ping) keep going to `composer-2-fast` for cheapness — that's what copilot-api does too. Behavior is non-Claude but it's just a "hello" probe so it doesn't matter.
- `claude-haiku-*` requests **with tools** transparently upgrade to `claude-sonnet-4-6` (smallest real Claude on Cursor) so the client gets actual Claude semantics.

The user-facing model name in the response is preserved as whatever the client requested (e.g., `"model":"claude-haiku-4-5"` in the response even though the underlying upstream is sonnet). This keeps clients that key on the model id happy.

## Claude Code `/btw` (side-question / fork) — wire shape

Captured from Claude Code v2.1.133 with `DUMP_REQUESTS=1` enabled. Useful for debugging when `/btw` appears silent.

`/btw` is **not a special endpoint**. It's a regular `POST /v1/messages` with prompt engineering. Specifically:

- Endpoint: `POST /v1/messages` (the same one as a normal turn)
- `stream: true`
- Full conversation history is included as `messages[]`
- The new side-question is appended as a fresh `user` message; its content is a **single string** wrapping a `<system-reminder>` tag with the side-question framing, followed by the actual question:

```text
<system-reminder>This is a side question from the user. You must answer this
question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

what does the acronym REST stand for?
```

- `tools[]` — **still includes the full tool list** (50+ for stock Claude Code). Claude Code does NOT strip tools from `/btw` requests; it relies on the `<system-reminder>` to forbid use. The model honors this.
- The answer comes back as plain text via the standard `message_stop` SSE flow. Claude Code displays it in a popup overlay ("↑/↓ to scroll · f to fork · Esc to dismiss").

### Implications for the proxy

- **No special endpoint or routing needed.** `/btw` works automatically once the regular `/v1/messages` path works.
- **`mcp_` prefix on tool names matters here too** — even though the model won't call them, the tool list is still validated upstream. Without prefixing the request would 503 like every other tool-bearing request.
- **Context size matters**: `/btw` adds the full history + system-reminder + tools. On long sessions this can push the request over Cursor's per-request schema budget. The default trim knobs (`TOOL_DESC_LIMIT=600`, `TOOL_SCHEMA_TRIM_BYTES=30000`) handle stock Claude Code; if `/btw` fails on your specific session, dump the request and check the encoded byte size.
- **Subagent classification does NOT fire for `/btw`** — there's no `__SUBAGENT_MARKER__` because `/btw` is just a fork on the user's main thread, not a subagent spawn.

### Debugging when `/btw` is silent

The popup overlay is easy to miss when the answer is a single line. If the question genuinely got no response:

1. `DUMP_REQUESTS=1 DEBUG_LOG=verbose PORT=4141 npm start`
2. Trigger `/btw` in Claude Code
3. Check `/tmp/v1messages-*.json` for the request body
4. Check `logs/server-*.log` for the request_id, then `grep` everything for that request_id
5. If you see `ERROR_PROVIDER_ERROR resource_exhausted`, the request hit Cursor's tool budget — try `TOOL_INCLUDE` to slim it
6. If you see `❌ Connect error internal: Blob not found`, retry — the prior bridge state was stale and is now evicted (next request will succeed)
7. If the request succeeded but Claude Code shows nothing, check whether the response was empty (model decided not to answer) or whether the SSE stream was malformed; the dumped request + verbose log should make this visible

### About `/v1/messages/count_tokens`

We DID implement this endpoint (commit 219f978) on the assumption that `/btw` calls it for fit-checks. Empirically Claude Code 2.1.133 does NOT call it for `/btw`. The endpoint is still useful — other Anthropic-SDK clients DO call it, and Claude Code might in future versions. Char-count heuristic at ~3.5 chars/token, returns `{input_tokens: N}`. Not exact but close-enough.

---

## Concurrency: what's safe, what's not

### Concurrency-safe by design

Multiple concurrent client sessions hitting the proxy are mostly fine:

- **HTTP server**: standard Express; each request has its own `req`/`res`.
- **Shared HTTP/2 client to api2.cursor.sh**: HTTP/2 multiplexes streams. Each `/v1/messages` opens its own stream via `client.request()` on the shared client. Cursor dispatches frames by stream ID; data flows to the correct `req.on('data')` listener with no cross-talk.
- **Per-stream frame buffers**: each `startConversation()` invocation has its own `buffer` closure. No shared state between streams.
- **SSE response writes**: each turn's callback closure captures its own `res`; events go to the right client.
- **Per-request state machines** (`turnState`, accumulated text, pending tool calls, block indices): all local-per-request.

### The bridge/conv cache is the one place to be careful

`activeBridges` is keyed on a stable hash of the conversation. If two concurrent sessions hashed to the same key, they'd collide → one would orphan the other's stream OR (worse) their tool_result follow-ups would land on the wrong bridge → **actual cross-session interleaving**.

Original key was `sha256("bridge:" + model + ":" + first200CharsOfFirstUserText)` — too narrow. Two sessions sending the same first prompt with the same effective model would collide.

Hardened to include 4 components, all stable across continuations of the same conversation but variable across different sessions:

```js
key = sha256("bridge:" + modelId + ":" + systemFingerprint + ":" + firstUserText.slice(0,200) + ":" + remoteAddr)
```

- **`systemFingerprint`** = concat of `system` text blocks (Anthropic's system field). Mostly per-client (Claude Code injects skill list + env + project info that differ between users). Strips the `x-anthropic-billing-header` block first since that contains a per-request `cch=<hash>` that would otherwise change every turn and break continuation matching.
- **`remoteAddr`** = `req.ip` (or `socket.remoteAddress`). Different machines diverge automatically. Behind a NAT this is shared, so same-machine collision is still possible if `system + firstUserText + model` all match — but Claude Code's system content (skill list, working dir, env) varies enough that real-world collisions are very rare.

### Edge case fix: two sessions with identical first prompts

Two Claude Code processes started in the same working directory on the same machine, with the same skill set and same first user text (e.g., a SWE-bench-style harness running the same template across many tasks), still collided on the original 4-component hash. Symptom in the wild:

- Session A is mid-tool-round-trip; its bridge is at `activeBridges[K]`
- Session B arrives with `continuation=false` — `handleFreshTurn` `set`s a new bridge at the same `K`, **overwriting A's**
- A's next `tool_result` POST does `activeBridges.get(K)` → gets B's stream → A writes its tool_result onto B's H2 stream
- B's stream gets a foreign tool_result, A's real stream is orphaned waiting forever — A *appears* blocked while B happily runs

Fix: extend the salt to 6 components.

```js
key = sha256("bridge:"
  + modelId + ":"
  + systemFingerprint + ":"
  + firstUserText.slice(0,200) + ":"
  + remoteAddr + ":"
  + remotePort + ":"
  + sortedToolNamesHash)
```

- **`remotePort`** = `req.socket.remotePort`. A claude-code process keeps a single keep-alive socket, so the port is stable within a session. Two concurrent processes get distinct ports → distinct keys → no collision.
- **`sortedToolNamesHash`** = SHA-256 of comma-joined sorted tool names, truncated to 8 hex chars. Stable within a session (tool list doesn't change across continuations). Diverges across sessions with different tool sets (one with `mcp__playwright_*`, one without) even on the same TCP socket. Tool order doesn't matter.

**Cost (mitigated below):** if a client's keep-alive times out and reconnects mid-conversation (e.g., undici's default 4 s `keepAliveTimeout` elapses during a long model-thinking pause), the new socket has a different port → bridgeKey lookup misses. We added a *second* cache index keyed on a per-bridge `sessionId` (uuid) embedded into every `tool_use_id` we mint, so continuations resolve via sessionId regardless of TCP socket. See next subsection.

Verified:
- Unit test (8 cases): same client / continuation matches; different port / IP / model / tools / system all diverge; tool order is stable.
- E2E: two parallel `claude -p` invocations with **identical** prompts on the same machine got distinct convKeys (`11eb2c30221071d5` vs `58aa770ea5201950`) and both completed cleanly. Pre-fix they would have collided.

### Bridge cache, second index: by sessionId

After the salted-key fix, real-world traces showed `Bridge cache miss for continuation; starting fresh` firing on roughly every other continuation in long sessions. Cause: undici's default `keepAliveTimeout` is 4 s, and a single Opus thinking turn often lasts longer. The follow-up POST lands on a fresh TCP socket → new `remotePort` → the `bridgeKey` (which now includes `remotePort`) doesn't match. The fallback works — it rebuilds the conversation from the message history — but at 100 KB+ of context, every miss costs an extra H2 stream and a re-upload.

Fix: every `tool_use_id` minted by the proxy now carries a per-bridge `sessionId` (uuid v4) in its `si` field. We maintain two indices over the same bridge entry:

```
activeBridges:      bridgeKey   → entry   (works when client reuses keep-alive socket)
bridgesBySessionId: sessionId   → entry   (works across TCP reconnects — sessionId is stable)
```

Continuation lookup tries sessionId first (extracted from the first `tool_result`'s `tool_use_id`) and falls back to `bridgeKey`. The two pointers are kept in sync on insert / delete / TTL-evict.

Why uuid: even if two concurrent sessions hash to the same `bridgeKey`, their bridges get distinct uuids → no aliasing across sessions. So sessionId carries both stability (per-bridge identity) and uniqueness (per-bridge nonce) — properties the salt alone could only approximate.

Format:
```js
toolu_<base64url(JSON({
  ck: convKey,    // legacy — still encoded for debug/logs
  ei: execId,     // Cursor's execution id
  tc: toolCallId, // Cursor's tool call id
  si: sessionId,  // NEW: per-bridge uuid; old IDs without `si` decode as sessionId=""
}))>
```

Backward compat: `decodeToolUseId` returns `sessionId: ""` for any `toolu_` minted before this field existed; the lookup then falls through to bridgeKey as before.

Verified:
- Targeted test: drove 2 turns with explicit `Connection: close` between them (force a fresh TCP). Pre-fix: cache miss + fallback. Post-fix: log line `↪️ continuation cache hit via sessionId=…` and zero misses.
- E2E parallel test: two identical-prompt `claude -p` sessions completed with **0 cache misses** and 3 sessionId hits across their continuations.

### Bridge cache, third refinement: alias tracking

Subtle leak surfaced in code review: when a continuation hits via sessionId on a different remotePort, `finalizeToolUseTurn` re-caches the entry under the *new* bridgeKey but the *old* alias persists in `activeBridges`. Long sessions accumulate stale aliases that block on TTL eviction (which can also try to close the bridge twice).

Fix: track every bridgeKey an entry has ever been indexed under in `entry.bridgeKeys` (a `Set`). On bridge close — whether via end_turn, error, or TTL eviction — `dropBridgeEntry` walks the set and deletes every alias. `indexBridgeEntry` is the only path that writes to either map, ensuring the set stays in sync. Same pattern applies to fresh-turn vs continuation paths in `buildTurnCallbacks`: continuations mutate the existing entry in place (preserving its alias set) instead of creating a new one.

### H2 client pool

A second concern surfaced in review: a single shared HTTP/2 connection means every claude-code session competes on one connection-level flow-control budget and one upstream scheduling context. Even though HTTP/2 multiplexes streams, in practice a long tool-heavy turn can degrade scheduling fairness for a sibling no-tool query.

Fix: replace the single `_sharedClient` with a pool of `H2_POOL_SIZE` (default 3) pre-warmed clients. Round-robin assignment per fresh stream gives each lane its own flow-control budget. `poisonSharedClient(reason, client)` only nulls the specific failing client's slot; sibling slots are untouched. Refill is lazy.

Continuations stay on whichever client opened their original stream (the bridge holds the `req` reference), so sessionId-based cache hits don't bounce between connections.

### Per-request timing logs

Every turn end now logs a compact `⏱` line with milestones relative to `t0` (request received): `firstFrame`, `firstText` or `firstTool`, `turnEnded`, `respEnded`. Lets the user see at a glance whether a slow request was upstream Cursor latency (large `firstFrame`) or local proxy work (`turnEnded → respEnded` gap). Sample line:

```
✅ turn ended | in=16586 out=56 | stopReason=end_turn | toolCalls=0 | ⏱ firstFrame=4606ms firstText=4606ms turnEnded=5038ms respEnded=5038ms
```

### `pickToken` deferred until fresh-turn path

Previously `pickToken()` ran on every `/v1/messages` POST, including continuations that don't actually use a fresh token. Each unused call advanced `roundRobinIndex`, skewing token assignment for unrelated fresh requests. Moved the call to after continuation cache lookup so cache-hits are token-agnostic.

### IDE-style request headers

Per the reverse-engineering doc (Cursor IDE API 逆向工程文档.md §2), Cursor IDE always sends a set of "optional but always-present" headers we were omitting:

| Header | Value |
|---|---|
| `x-session-id` | per-bridge UUID — same value as the one baked into our `tool_use_id` |
| `x-ghost-mode` | `false` |
| `x-cursor-client-type` | `ide` (override via `CURSOR_CLIENT_TYPE`) |
| `x-cursor-client-os` | derived from `process.platform` (override via `CURSOR_CLIENT_OS`) |
| `x-cursor-client-arch` | derived from `process.arch` (override via `CURSOR_CLIENT_ARCH`) |
| `x-cursor-client-device-type` | `desktop` (override via `CURSOR_CLIENT_DEVICE_TYPE`) |

`x-session-id` is the one we hypothesize matters most: without it, multiple concurrent claude-code sessions share the same identity from Cursor's backend perspective and may share whatever per-session scheduling buckets exist there. With it set to a fresh UUID per bridge, each session looks distinct.

### Honoring `--effort` and `thinking.type` per request

Static model mapping in `src/config.js` always sent Opus 4.7 to `claude-opus-4-7-thinking-max` regardless of what the client asked for, so claude-code's `--effort` flag was a no-op through the proxy. The live model list (`/v1/models`) shows Cursor exposes a full grid for Opus 4.7:

```
claude-opus-4-7-{low,medium,high,xhigh,max}            # non-thinking
claude-opus-4-7-thinking-{low,medium,high,xhigh,max}   # thinking
```

…and Sonnet 4.6 exposes `claude-4.6-sonnet-medium` and `-medium-thinking`.

claude-code's request body carries:
- `output_config.effort` ∈ `{low,medium,high,xhigh,max}` — set by `--effort`. Default is `low`.
- `thinking.type` ∈ `{adaptive,enabled,disabled}` — claude-code sets `adaptive` by default.

`extractModelOverrides(body)` reads both fields. `applyModelOverrides(model, opts)` rebuilds the suffix for known model families (Opus 4.7 full grid, Sonnet 4.6 thinking on/off, Sonnet 4.5/4, Opus 4.6/4.5). Unknown families pass through unchanged so misconfigured clients don't end up at invalid model names.

Env-var force-overrides win over the body for ops scenarios:
- `CURSOR_FORCE_EFFORT=low|medium|high|xhigh|max` — pin effort regardless of client.
- `CURSOR_FORCE_THINKING=on|off|adaptive` — pin thinking regardless of client.

The routing log now shows `override(effort=…, thinking=…): old → new` whenever the per-request override changes the model.

Verified: `--effort low/medium/high/xhigh/max` each route to the matching Cursor variant; `CURSOR_FORCE_EFFORT=max` overrides client `--effort low` back to max; `CURSOR_FORCE_THINKING=off` strips the `-thinking-` segment.

### `interactionQuery` handler — fixes hangs on WebSearch / WebFetch / similar

Cursor uses **two** separate channels for native tool calls:
- `ExecServerMessage` for `read/write/shell/grep/...` — we already reject these to force MCP fallback.
- `InteractionQuery` for `WebSearch / WebFetch / ExaSearch / ExaFetch / AskQuestion / SwitchMode / ...` — we used to silently drop these (`if (msgCase === 'interactionQuery') return;`).

Silently dropping caused the model to hang indefinitely waiting for our `InteractionResponse`. The whole turn would time out (90s in our test).

Fix: implement `handleInteractionQuery`, mirroring the `handleExecMessage` pattern. For known query types we send `Rejected` so the model falls back to the MCP-prefixed equivalent (e.g. `mcp_WebSearch`):

| Query case | Rejected via |
|---|---|
| `webSearchRequestQuery` | `WebSearchRequestResponse_Rejected` |
| `webFetchRequestQuery` | (proto field 9, not in vendored proto — abandoned) |
| `exaSearchRequestQuery` | `ExaSearchRequestResponse_Rejected` |
| `exaFetchRequestQuery` | `ExaFetchRequestResponse_Rejected` |
| `switchModeRequestQuery` | `SwitchModeRequestResponse_Rejected` |
| `askQuestionInteractionQuery` | `AskQuestionRejected` |
| _anything else_ | bare `InteractionResponse{id}` with unset `result` oneof — Cursor treats as abandoned and the model falls back |

The vendored proto module is older than the proto definitions in `/tmp/cursor-tap/` so a few newer fields (notably `web_fetch_request_query`) decode as `case=undefined`. The abandoned-response fallback handles them — the model still gets unblocked and routes through MCP.

Verified end-to-end:
- WebSearch via claude-code → completes (`done`).
- WebFetch via claude-code → completes (`page title is "Example Domain"`).
- Three concurrent sessions (Bash + WebSearch + WebFetch) → all complete with their unique markers, 0 errors, 0 cache misses.

### Verified

- 4-way unit test: identical-conversation continuation matches; different IP / different system / different model all diverge.
- End-to-end: `claude -p` with tool round-trip → both requests share `convKey`, bridge cache hit, no "Bridge cache miss" warning, correct file content returned.

### Strengthen latest-user framing on long histories

**Why this was needed.** After tagging user messages with `<user>` and marking the latest with `<user latest="true">` (see next section), the user reported pivots on a 2051-message session *still* failed. Captured request body:

```
msg count: 2051
last role: user
  block[0] text='do handover instead'
```

Proxy correctly forwarded everything; the model saw `<user latest="true">do handover instead</user>` at the end of 2051 messages of accumulated plan-state and **still kept executing the prior plan**. The structural tag was insufficient against that much context inertia.

**Fix.** When *any* of these is true for the latest user message, inject an explicit directive inside the wrapper telling the model the content is the active request and not to auto-continue prior plans:

- Total message count ≥ `LATEST_USER_FRAMING_THRESHOLD` (default 50).
- Content matches `[Request interrupted by user]` (claude-code's interrupt marker).
- Content matches a pivot-keyword regex: `stop|halt|abort|cancel|instead|nevermind|forget (that|the|previous)|switch to|do … instead|change of plans|new plan|forget everything|start over`.

The directive is short and semantic, with three flavor variants depending on which signal fired:

```
<user latest="true">
[ATTENTION — CURRENT USER TURN. {flavor}. Respond directly to it;
do NOT auto-continue the prior plan unless the user explicitly asks
you to.]

do handover instead
</user>
```

`{flavor}` is one of:
- `The user has interrupted the prior plan. The message below is the new directive.` (interrupt marker)
- `The message below appears to redirect or override the prior plan.` (pivot keywords)
- `The conversation above is history; the message below is the user's active request.` (long history)

**Verified end-to-end:** 3-message synthetic with "do handover instead" → model now correctly responds about handover instead of continuing prior task. Short prompts without pivot signals are unchanged (no ATTENTION line emitted). Tool round-trip continues to work normally.

**Knobs:**
- `LATEST_USER_FRAMING_THRESHOLD=N` — message count threshold (default 50). Set higher to make the directive rarer.

**Trade-off:** the directive is text we inject into the prompt; the model could in theory quote it back. Kept terse and semantic to minimize that risk. If false positives become a problem (e.g., user's "instead" wasn't actually a pivot), make the regex stricter or expose an `off` switch.

### Tag user messages in flattened prompt (and mark the latest)

**Bug.** Cursor's `agent.v1.AgentService/Run` accepts a single user-message text per runRequest, so we flatten the entire Anthropic `messages` array into one string via `anthropicMessagesToPrompt`. For years the function tagged `<system>...</system>` and `<assistant>...</assistant>` but emitted user messages as **bare text with no role marker**. On long sessions (1000+ messages of accumulated tool_result history), the model couldn't distinguish "what the user just said" from "more user content embedded in history" — every user turn looked identical.

User-visible symptom: the user issues a mid-session pivot ("do handover instead"), claude-code dutifully POSTs `messages` with the new instruction as the latest user turn, the proxy faithfully forwards everything — and the model continues the prior plan as if the new instruction were just more context. Direct claude-code → Anthropic doesn't have this problem because the structured `messages` array preserves explicit role boundaries.

**Fix.** Wrap every user turn with `<user>...</user>`, and mark the most recent one with `<user latest="true">...</user>`. Three lines of new logic; the rest of the function unchanged. Now the model sees clear role boundaries throughout the history and a structural cue for "this is the user's current ask" at the end.

Before:
```
<system>...</system>

first prompt           ← bare text, role unclear

<assistant>...</assistant>

[Tool result for t1]:  ← bare text, role unclear
hostname-value
...
[Request interrupted]  ← bare text — buried in history, no signal it's NEW
do handover instead
```

After:
```
<system>...</system>

<user>first prompt</user>

<assistant>...</assistant>

<user>[Tool result for t1]: hostname-value</user>
...
<user latest="true">
[Request interrupted by user]
do handover instead
</user>
```

Verified: short prompts, tool round-trips, and the synthetic pivot test (continuation with text alongside tool_result) all work. The model sees the latest user turn clearly; pivot success rate on long sessions should improve dramatically.

### User-injection rescue: text alongside tool_result on continuation

A user reported: starting a session, queuing a "do a handover instead" instruction mid-task, hitting run, and watching the model continue the original work as if the new instruction never arrived.

Confirmed via synthetic test. The bridge / continuation path in `handleContinuation` extracts `tool_result` blocks from the latest user message and forwards them to the open Cursor stream as `mcpResult` frames. Anything else in that user message — text, image, etc. — is silently dropped: the loop never inspects non-tool_result blocks.

Diagnostic (run before the fix):

```
POST /v1/messages with messages=[
  user("Read /etc/hostname using the Read tool"),
  assistant(tool_use Read /etc/hostname),
  user([tool_result "my-greencloud-la",
        text "STOP. Forget previous task. Respond with the literal word DEMO and nothing else."])
]
```

Proxy log: `🔄 continuation | toolResults=1 | pendingExecs=1`. Response: a long paragraph about the hostname. The "STOP" text **never reached the model** — it was dropped at the cache-hit branch.

Fix: in the `/v1/messages` handler, after a cache hit but before calling `handleContinuation`, scan the latest user message for any non-`tool_result` content. If found, drop the bridge entry (clearing both `activeBridges` aliases and the `bridgesBySessionId` index) and let the request fall through to `handleFreshTurn`. The fresh-turn path uploads the full message history — which includes the user's new instruction — so the model actually sees it.

```js
const lastUser = anthropicTools.findLatestUserMessage(messages);
const hasUserInjection =
  lastUser && Array.isArray(lastUser.content) &&
  lastUser.content.some(b => b && b.type && b.type !== 'tool_result');
if (hasUserInjection) {
  dropBridgeEntry(cached, 'user-injected-content');
  cached = null;
}
```

Cost: when this fires, we pay a fresh-turn upload (full history, can be 1MB+ on long sessions). This is unavoidable — Cursor's protocol doesn't support injecting new user content mid-stream. Strictly better than silent data loss.

Why this couldn't be fixed via mid-stream `userMessageAction`: Cursor's `agent.v1.AgentService/Run` expects one `runRequest` and a defined message lifecycle. Injecting a second `userMessageAction` over the existing stream is unspecified and could trigger protocol errors. The fresh-turn path is the supported way to deliver new user content.

Verified post-fix:
- Same synthetic continuation: log shows `↪️ user-injected content alongside tool_result (text); forcing fresh-turn`, then `⚠️ Bridge cache miss for continuation; starting fresh`. The model receives the full history including the STOP instruction (and reasons about it; in this case correctly identifying it as a prompt-injection attempt — but the key win is it *saw* the instruction).
- Clean continuation (only tool_result, no text): still cache-hits via sessionId. No regression.

### Selective `mcp_` prefix (`MCP_PREFIX=safe-only` default)

The proxy used to prefix every registered tool with `mcp_` to avoid `ERROR_PROVIDER_ERROR / resource_exhausted` collisions with Cursor's built-in tool surface. That made tools the model already knows from training — `Bash`, `AskUserQuestion`, `Edit`, etc. — appear under unfamiliar prefixed names. When the model was confused (long contexts, low-effort variants, name aliases), it occasionally fell back to emitting `[Tool call: NAME({...})]` as plain text instead of as a structured tool_use block.

Fix: keep the prefix only for tools whose names actually conflict with Cursor's blocklist:

```
Read, Write, Grep, Glob, WebFetch, WebSearch, Shell, Delete,
Task, TodoWrite, AskQuestion, ListMcpResources, ReadLints,
SwitchMode, Ls, Fetch, Diagnostics
```

Tools without conflicts (`Bash`, `AskUserQuestion`, `Edit`, `MultiEdit`, `NotebookEdit`, `BashOutput`, `KillBash`, custom MCP tools, ...) are now registered with their natural names. The model recognizes them and is significantly more likely to call them via structured tool_use.

Env knob `MCP_PREFIX`:
- `safe-only` (default) — prefix only conflict-prone names.
- `always` — legacy behavior, prefix everything. Use this if `safe-only` ever produces `ERROR_PROVIDER_ERROR` for a tool we hadn't realized conflicts.
- `never` — debug only, no prefix on anything.

Verified:
- `Bash`, `LS` → registered as `Bash`, `LS` (natural names); model calls structurally.
- `Read`, `WebSearch` → registered as `mcp_Read`, `mcp_WebSearch` (still prefixed); model calls via the prefixed name.

(Aborted side-attempt: tried injecting a tool-use nudge via `runRequest.customSystemPrompt`. Cursor's upstream rejected those requests with `Connect error invalid_argument: unknown option '--system-prompt'` — the field appears account-gated in ways we can't safely probe. Removed.)

### Perf review fixes

A code review surfaced 8 perf/quality concerns. After verifying each against the actual code, kept 5 as real wins:

1. **`/v1/models` 5-min TTL cache.** `cursor-client.getModels` opens a fresh H2/TLS connection per call; claude-code polls /models on startup. Cache hit takes the call from ~580ms → ~30ms (20×). Stale-on-error: if the upstream call fails, serve last good response rather than empty.

2. **Frame-parser O(n²) → O(n) on long streams.** `parseFrames` did `buffer = Buffer.concat([buffer, chunk])` on *every* data event, copying the entire carry buffer each time. Replaced with a "concat only when there's a leftover partial frame" pattern. Common case (chunk lands aligned to whole frames) parses straight from `chunk` with zero copies. After the loop, fully-consumed buffers reset to a shared `Buffer.alloc(0)` instead of slicing. Same fix in `cursor-client.js`.

3. **Skip `accumulatedText`/`accumulatedThinking` when streaming.** JS strings are immutable; `s += chunk` is O(n²) over a long generation. The accumulator is only read for non-stream responses (which need the full text to build the JSON body). For streams, the deltas are already on the wire — no reason to also keep a growing local copy.

4. **Reuse one `chatcmpl-<id>` per OpenAI stream.** `buildStreamChunk` was minting a fresh UUID per delta. OpenAI clients expect one id across the whole stream. Added `newStreamIdentity()` helper called once per request; passed into every chunk builder. (Correctness, not perf — but visible in clients that track ids.)

5. **Cache `Intl.DateTimeFormat().resolvedOptions().timeZone` at module load.** Timezone never changes mid-process; was being recomputed per request in `buildHeaders`.

Skipped (3 of 8) with reasoning:
- **Backpressure on `res.write()`**: theoretical concern; not the user's current pain point. Defer until a slow-client failure is observed.
- **Tool-schema cache**: only fires per fresh turn (not per tool call), and the encoding cost is ~2-3ms. Marginal.
- **Async debug-log writes**: only relevant when `DEBUG_LOG=verbose` is on. Not the production path.

Verified end-to-end:
- Models cache: 580ms → 30ms.
- Stream-id: was N distinct ids per stream, now exactly 1.
- claude-code Anthropic flow still works after frame-parser change.

### Auto-retry extended to `NGHTTP2_INTERNAL_ERROR` + per-pool-slot eviction

User log under heavy long-session load showed `Stream closed with error code NGHTTP2_INTERNAL_ERROR` firing mid-conversation on long sessions (toolResults=320+, accumulated history ~1MB). Cursor's server seems to give up on streams that stay open too long with too much state. The error fires AFTER data has flowed, so the original REFUSED_STREAM-only retry didn't apply.

Two refinements:

1. **Distinguish "received data" from "emitted client-visible content"**. `hasReceivedData` tracks raw H2 bytes (which includes setup chatter — requestContextArgs, blob handshakes, heartbeats). `hasEmittedContent` is set only when we forward textDelta / thinkingDelta / mcpArgs to the client. Retry safety hinges on the latter: if no client-visible content has flowed, a fresh attempt won't produce duplicate output.

2. **Add `INTERNAL_ERROR` to the retryable set**. Per H2 spec, `INTERNAL_ERROR` is a soft, server-side hiccup that's safe to retry on a fresh stream — same logic as `REFUSED_STREAM`. The retry condition is now `(!hasEmittedContent && retryAttempts < MAX) && (REFUSED_STREAM || INTERNAL_ERROR)`.

3. **Per-pool-slot error tracking**. `_poolErrorCount[slot]` increments on every transient error. After 3 errors on the same slot, `reportSlotError` evicts it (nulls the slot, GC reaps the underlying client when its remaining streams drain). Sibling slots are untouched. This prevents one bad pool slot from cascading errors across many sessions.

Verified:
- Fault-injection: synthetic `NGHTTP2_INTERNAL_ERROR` on the first attempt → retry on a fresh pool slot → second attempt holds. Logs show `poisoning pool slot #0: ... INTERNAL_ERROR` and `opening pool client #1`.
- Smoke test under real claude-code: tool round-trip completes normally; no spurious retries.

What this *doesn't* fix: when a session genuinely accumulates 300+ tool_results, claude-code may still hit Cursor's per-stream limits and end up doing a fresh-turn cache-miss with a 1MB+ context re-upload. That's a client-side compaction concern (claude-code has `/compact` for it) — out of scope for the proxy.

### Auto-retry on `NGHTTP2_REFUSED_STREAM`

Symptom (observed 2026-05-07): a session running alongside others died with `[Error: Stream closed with error code NGHTTP2_REFUSED_STREAM]`. Per HTTP/2 spec this code is explicitly safe to retry — the server refused the stream before processing it (typically per-connection stream limit hit, server about to GOAWAY, or transient overload).

Fix in `cursor-agent.js`:

- Track `hasReceivedData` on the stream. Only retry if no data has arrived yet — past first byte we may have partial state.
- On `req.on('error')`, dispatch through `failOrRetry(proto, msg, code)` which:
  1. Tests the message/code for `REFUSED_STREAM`.
  2. If retryable and under budget (`MAX_REQUEST_RETRIES = 2`):
     - Calls `poisonSharedClient()` so the next stream uses a fresh H2 connection (the old one likely has stream-id pressure).
     - Removes listeners + destroys the dead `req` so its trailing `end` event can't flip `closed = true` and short-circuit the retry.
     - Schedules `attemptConnection(proto)` after `50ms × attempt` backoff.
     - Re-sends the cached initial `runRequest` bytes (`cachedInitialEncoded`) on the new stream.
  3. Otherwise bubbles to `fail(msg)` as before.
- Refactored `startConnection` into `startConnection` (one-time runRequest build + send) + `attemptConnection` (re-runnable network setup) so the retry path is cheap.

Verified with a fault-injection test (monkey-patched `http2.connect`): first stream emits `NGHTTP2_REFUSED_STREAM` immediately after the runRequest write → the proxy retries on a fresh client + re-sends the cached bytes. The user-visible failure mode collapses into a sub-second hiccup.

Limits: only retries if zero bytes have arrived (mid-stream errors are not retried — could mask state-corruption bugs). Cap at 2 retries to avoid hammering Cursor when it's actually saturated.

---

## Conversation/bridge cache: state is per-stream, NOT per-conversation

We maintain two in-memory caches on the proxy:

- `activeBridges` keyed by `bridgeKey` — stores the open H2 stream + pending exec list. Used to route `tool_result` follow-ups back to the **same** Cursor stream. This works.
- `conversationStates` keyed by `convKey` — was supposed to cache the opaque protobuf checkpoint Cursor sends back via `conversationCheckpointUpdate`, so a fresh `/v1/messages` request could resume a previous conversation without re-uploading context. **This does not work** — Cursor's KV blob store is scoped per-H2-stream, not per-conversation-id. Replaying a saved checkpoint on a fresh stream causes `Connect error internal: Blob not found` because the stored blob hashes only existed in the closed stream.

Key derivation has a preferred path and a fallback path (see `deriveConversationKey` / `deriveBridgeKey` in `src/anthropic-tools.js`):
- **Preferred (v2):** if the client sends `x-claude-code-session-id` (or the same UUID nested as `body.metadata.user_id.session_id`), keys are `sha256("conv-v2:" + modelId + ":" + sessionId)` / `sha256("bridge-v2:" + ...)`. This is the only signal that reliably distinguishes two concurrent claude-code sessions sharing remoteAddr+remotePort+firstUserText.
- **Fallback (v1):** for callers that don't send the session header, keys remain `sha256("conv:" + modelId + ":" + sysFingerprint + ":" + firstUserText.slice(0,200) + ":" + addr + ":" + port + ":" + toolHash)`. Less robust but historical behavior.

See the [convKey collision fix](#convkey-collision-fix-2026-05-14) entry below for the bug this addresses.

**Current behavior:** every fresh `/v1/messages` request starts with empty `conversationState`. Cursor rebuilds its blob store from `setBlobArgs` (system prompt, etc.) and the client re-supplies the message history in the prompt anyway. The `conversationStates` Map is preserved as scaffolding for a future architecture where we share an H2 client across requests, but it's not currently populated.

Bridge cache expires after 30 minutes of inactivity. Bridges with pending tool calls are kept alive for the client's continuation POST.

---

## Cross-referencing with other Cursor RE projects

Survey of three external reverse-engineering efforts produced a small set of optimizations that bring real value (most of what they document, we already do correctly — and in a few cases, more correctly than they do).

Repos consulted:
- [`JJDTrump/cursor-reverse-engineering`](https://github.com/JJDTrump/cursor-reverse-engineering) — single-README deep dive on Cursor IDE v3.2.11 (gRPC service list, headers, ModelDetails). Several claims stale vs. current `agent.v1.AgentService`; the documented "HMAC" checksum is plausibly wrong. Our XOR-feedback `generateChecksum()` (`src/cursor-client.js:11`) matches what every working open-source proxy uses.
- [`anyrobert/cursor-api-proxy`](https://github.com/anyrobert/cursor-api-proxy) — most polished CLI-wrapper proxy. Different architecture (wraps the local `cursor-agent` binary; we hit the backend directly), so half their tricks (`cli-config.json` writes, `CURSOR_CONFIG_DIRS`) don't apply. Their `account-pool.ts` health-aware token rotation is the standout idea that does port.
- [`JiuZ-Chn/Cursor-To-OpenAI`](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) (164 ⭐) — closest peer (backend-direct). Slightly fuller header set; documents a PKCE login flow we don't currently support.
- [`unkn0wncode/extract-cursor-protos`](https://github.com/unkn0wncode/extract-cursor-protos) — pulls the full `aiserver.v1` + `agent.v1` proto registry (~23k lines, ~64 services, ~792 RPCs) straight from Cursor's bundle. Useful for spotting services we don't surface (e.g. `AuthService.CheckSessionToken`); we keep our hand-curated subset to avoid dragging in the whole file.

What we already do that they document (no change needed):
- `x-cursor-checksum` algorithm (XOR-feedback ladder, base64'd 6-byte timestamp + machineId/macMachineId).
- `mcp_` prefix workaround on tool names; KV blob ACK; synthesized `stop_reason=tool_use`.
- Per-stream `x-session-id` UUID (the load-bearing one for concurrent sessions).
- `x-ghost-mode`, client-type/os/arch fingerprint headers.
- Real input/output token counts parsed from `tokenDelta` / `conversationCheckpointUpdate` (anyrobert's README admits theirs is `chars/4` heuristic — don't regress to that).
- Telemetry silence (no Sentry, no `metrics.cursor.sh`). Sending those would actively expose abuse signals.

Optimizations we adopted from this round:

1. **Health-aware `TokenPool`** (ported from anyrobert's `account-pool.ts`). Replaces the old naive round-robin (server.js had a single `roundRobinIndex` global). Each token now carries `{activeRequests, lastUsed, rateLimitUntil, totalRequests, totalErrors, totalRateLimits}`; `pick()` filters out parked tokens, sorts the survivors by least-busy + LRU, and falls through to the fastest-recovering one if every token is parked. `release()` is idempotent (each pick returns a fresh ticket with a `_released` flag) so a `try/finally` plus an `res.on('close')` backstop double-cover the request lifecycle without double-decrementing. 429 detection is heuristic-based (status 429, `RESOURCE_EXHAUSTED`, regex match on the error string) and parks for 60 s by default (`TOKEN_RATE_LIMIT_PARK_MS`). The fresh-turn path in `/v1/messages` defers `pick()` until after the bridge-cache miss check so we don't burn a ticket on a continuation that ends up reusing the existing H2 stream. `/health` now exposes `tokenPool.stats()` with redacted token suffixes (last 6 chars only). Single-token deployments are unaffected — same one token gets picked every call, only with health-aware parking on 429s.

2. **Anthropic-aliased `/v1/models`**. Previously we emitted only Cursor-internal IDs (`claude-opus-4-7-thinking-max` etc.); Claude Code wants Anthropic-shaped IDs in its model picker. New `buildModelsResponseWithAnthropicAliases()` in `src/anthropic-converter.js` walks `config.anthropicModelMapping`, and for each Anthropic key whose Cursor target is in the live model list it emits an extra entry with `owned_by: 'anthropic-via-cursor'` and `root: <cursor_id>`. Cursor IDs are still emitted unchanged (so existing OpenAI-style clients are not affected). Aliases for non-live Cursor targets are silently dropped.

3. **Dated-variant fallback in `mapAnthropicModel`**. Anthropic ships ID variants with date suffixes (`claude-opus-4-7-20250507`); we hand-list the ones we know in `config.anthropicModelMapping`. Future-dated variants (e.g. `claude-opus-4-7-20990101`) would have fallen through to pass-through and 404'd at Cursor. Now `mapAnthropicModel` strips a trailing `-YYYYMMDD` and retries the lookup against the bare key, so a future date suffix on a known family resolves correctly without a config change. Unknown families still pass through.

4. **IDE-fingerprint headers**: added `x-cursor-client-os-version` (defaults to `os.release()`) and `x-cursor-commit` (defaults to v3.2.11's published distro hash, `d5c0e77a02...`) to `buildHeaders()` in `src/cursor-agent.js`. Both env-overridable (`CURSOR_CLIENT_OS_VERSION`, `CURSOR_COMMIT`). Marginal but real: matches the IDE's wire shape more closely.

5. **`CURSOR_API_BASE_URL` env override**. The IDE itself reads this; we now do too. Useful for staging endpoints, regional steering, or testing against a packet-capture proxy.

What we explicitly chose **not** to copy:
- Telemetry / Sentry / metrics submission — would actively expose us as a non-IDE client.
- `cli-config.json` Max Mode side-channel — CLI-only; on our backend-direct path Max Mode is encoded in `ModelDetails.max_mode` already.
- `CURSOR_CONFIG_DIRS` multi-account scheme — CLI-only; our `tokens[]` array already handles multi-account.
- gzip request bodies — most of our requests are small; gzip + Connect framing adds bookkeeping for negligible bandwidth gain.
- Stream-json double-emit dedup — CLI-specific; our backend doesn't double-emit.
- ACP JSON-RPC stdio dance — not relevant.
- PKCE login tool — useful but separate feature; deferred.

---

## Debugging methodology

When chasing stalls, slow turns, or "stuck" sessions, the high-leverage move is to start the proxy in the background with logs to a file, then live-tail-and-filter for turn lifecycle markers (`📨` / `✅ turn ended` / `❌` / `Upstream stalled` / `pool slot` / `429` etc.). One notification per real event; silence between `📨` and `✅` is itself the signal. The grep alternation must cover failure modes — silence is not success. See [DEBUGGING.md](DEBUGGING.md) for the recipe and the list of bugs we caught with it.

For *live* in-flight diagnosis (is this turn thinking, or stuck?), `GET /stats/inflight` exposes each active bridge's `idleMsSinceLastUsefulFrame`, `currentThresholdMs`, `willTripStallInMs`, `textDeltaCount`, `thinkingDeltaCount`, and `bytesInSinceLastUsefulFrame`. Decision rule: if delta counts rise between polls, the model is producing; if they're flat and `bytesInSinceLastUsefulFrame` is also flat, only heartbeats are flowing and the watchdog will trip in `willTripStallInMs`.

---

## Resilience: per-model adaptive stall thresholds + cascade backoff + idle pool recycling

The single 60-second (later 120-second) stall watchdog was simultaneously too aggressive for heavy `claude-opus-4-7-thinking-max` turns (false stalls during legitimate long reasoning pauses) and too lax for fast non-thinking variants. Replaced with a two-layer scheme in `src/stall-thresholds.js`:

**Layer 1 — feature-derived baseline.** Parse the Cursor model name into `isThinking`, `isOpus`, `effort` and compute thresholds from a small formula. Always available without warm-up:

| Model | pre-content / post-content |
|---|---|
| `claude-opus-4-7-thinking-max` | 180 s / 270 s |
| `claude-opus-4-7-thinking-medium` | 150 s / 225 s |
| `claude-opus-4-7-max` (non-thinking) | 120 s / 180 s |
| `claude-4.5-sonnet-thinking` | 120 s / 180 s |
| `claude-4.5-sonnet` (non-thinking) | 60 s / 90 s |

**Layer 2 — adaptive p99.** Each successful turn records its `maxIdleMs` (longest gap between useful frames) into a per-model rolling window of 50 samples. Once ≥20 samples for a model, the threshold becomes `max(MIN_PRE_MS, p99 × multiplier)`, clamped to `baseline × 2`. PRE_MULTIPLIER = 1.5, POST_MULTIPLIER = 2.5 (post-content stalls are expensive to retry — the partial response is already on the wire and the Anthropic SDK throws on mid-stream `event: error` — so we wait substantially longer there).

**Stall-driven elevation.** Adaptive p99 is steady-state and slow to react to transient outages. Layered on top: each watchdog trip multiplies the model's threshold by `ELEVATION_BUMP` (1.5, capped at 4.0). A successful turn resets it. While quiet, elevation decays exponentially with `ELEVATION_DECAY_TAU_MS` = 5 min. Hard ceiling at `baseline × 4` so a runaway elevation can't hide a real hang indefinitely.

Concrete trajectory for three consecutive stalls on opus-thinking-max (`baseline = 180 s`):

| Attempt | Elevation | Effective pre-content threshold |
|---|---|---|
| 1 (cold) | 1.0× | adaptive p99 × 1.5 (typically ~45 s for fast streams) |
| 2 (after 1st stall) | 1.5× | bumped from previous |
| 3 (after 2nd stall) | 2.25× | further bumped |
| 4 (after 3rd stall) | 3.375× | further bumped |
| 5+ | 4.0× (cap) | up to `baseline × 4` = 720 s |
| Any success | 1.0× | snaps back |

**Cascade-aware retry backoff.** Bumped `MAX_REQUEST_RETRIES` from 3 → 5 with schedule `[100, 250, 750, 2000, 5000]` ms (~8 s total window). When two consecutive errors are both transport-level (`REFUSED_STREAM` / `GOAWAY` / `INTERNAL_ERROR`), the LB is in a real cascade — double the next backoff (capped at 8 s). Was: 3 retries in ~1 s. The wider gap gives Cursor's load balancer time to actually stabilize. Verified end-to-end: a real cascade observed in production exhausted retries in ~1 s; the new schedule rides through it.

**Idle pool recycling.** Pre-warmed pool clients sat idle indefinitely under the previous design. Cursor's LB silently rotates connections under us — they look "open" from Node's POV but the LB has decided they're toast, so the first write returns `REFUSED_STREAM` with no `goaway` event firing. New background timer (every 60 s, `.unref()`-ed) closes any slot whose `_poolLastUsedAt` is older than `POOL_MAX_IDLE_MS` (5 min default, `CURSOR_POOL_MAX_IDLE_MS` to override). Eliminates the "first request after quiet period" cascade that used to require multiple caller-level retries to recover from.

---

## Runtime statistics: t-digest-backed per-mode + connection lifecycle aggregates

Lives in `src/runtime-stats.js`. Persists to `logs/runtime-stats.json` (override path with `RUNTIME_STATS_FILE`); snapshotted every 60 s when dirty and on graceful shutdown. Schema-versioned (v2 currently); old schemas are dropped on load and rebuild.

**Per-turn records** capture: `model`, `outcome` (`success`/`fail`), `isStream`, `isContinuation`, `durationMs`, `firstFrameMs`, `firstTextMs`, `firstToolMs`, `maxIdleMs`, `retries`, `transportErrors`, `stalls`, `cascadeDetected`, `toolCount`, `inputTokens`, `outputTokens`. Counters reset at every new-turn boundary in cursor-agent.js so values reflect just *this* turn (not the bridge's lifetime).

**Aggregations** — two parallel maps, both updated atomically per record:

- `byModel` — counters + t-digests keyed by model alone. Per-model lifetime totals.
- `byModelMode` — same shape, keyed by `${model}|${stream|nonstream}|${fresh|cont}`. Lets you ask "what's `firstFrameMs.p95` for `claude-opus-4-7-thinking-max` in stream-continuation mode."

For each model (or model+mode), the digests compute `p50`, `p95`, `p99`, and the counters give `successRate`, `firstTryRate` (success without any retry), `totalRetries`, `totalStalls`, `totalTransportErrors`, `totalCascades`, `totalToolCalls`.

Library: [`tdigest`](https://www.npmjs.com/package/tdigest) (pure JS, ~1 KB per digest, accurate at the tail, serializes to centroids array). Chosen over HdrHistogram because we don't need to declare a value range upfront and the merge operation (used in time-windowed views) is trivial.

**Time-windowed views.** A ring buffer (`recent`, last 1000 records by default; `RUNTIME_STATS_RECENT` to override) is replayed on demand for `?window=last1h` / `?window=last24h` / `?window=<ms>`. Lifetime view uses the pre-aggregated digests directly — O(1).

**Connection lifecycle** is tracked separately in `runtimeStats.connections`. Each pool client gets an open/close event; on close we record `ageMs`, `streamsServed`, `streamErrors`, `closeReason` (one of `goaway` / `error` / `closed` / `idle-recycle` / `poison`). Aggregates: t-digest of lifetimes, t-digest of streams-served-per-connection, counter per close reason, per-slot churn snapshot.

Endpoints:

```
GET /stats                                  # per-model lifetime
GET /stats?window=last1h&groupBy=modelMode  # mode breakdown for last hour
GET /stats?groupBy=mode                     # aggregated across models
GET /stats?model=<id>                       # single-model filter
GET /stats/connections                      # connection lifecycle + recent events
GET /stats/inflight                         # live state for in-flight bridges
GET /health                                 # adds compact last-1h totals + connection counters
```

Periodic log line every `RUNTIME_STATS_LOG_INTERVAL_MS` (off by default; useful in long-running deployments):

```
📈 runtime/last1h | turns=47 succ=95.7% firstTry=89.4% retries=8 stalls=2 cascades=1 | top opus-4-7-thinking-max: 32 (p95dur=14200ms p95first=2120ms)
```

The point of this whole apparatus: when stall thresholds need tuning, you should re-derive them from real `maxIdleMs.p99` per model rather than from my intuition. Pull `/stats?groupBy=modelMode` after a week of real traffic.

---

## Hallucination rescue v2: mixed-mode + streaming text suppression

**The bug.** Cursor's model occasionally falls out of structured-tool-use mode and emits a tool call as TEXT instead — `[Tool call: Read({"path":"/foo"})]` as a plain content delta. Real Claude Code's UI doesn't render anything that looks like that; the appearance of bracketed text is itself the hallucination signal. claude-code displays it verbatim and the tool never actually runs, so the conversation stalls.

Worse, the bracketed text often uses subtly-wrong schemas: `path` instead of `file_path` for Read/Write, `contents` instead of `content`, `old`/`new` instead of `old_string`/`new_string`. The model is making up the schema because it doesn't actually have the tool registered (or thinks it has a different one).

**The original rescue** (described elsewhere in this DEVLOG) parsed `emittedTextForDetection` at `onTurnEnded`, synthesized `tool_use` blocks via `parseHallucinatedToolCalls` + `canonicalizeHallucinatedToolName` (`AskQuestion`→`AskUserQuestion`, `Shell`→`Bash`) + `normalizeHallucinatedToolArgs` (the schema fixups above) — see `src/anthropic-tools.js:436-598`. Worked for pure-hallucination turns but had **three gates that silently skipped it** in mixed-mode (real-tool-use + hallucinated-text-in-same-turn) cases.

### Gate 1: `toolUseFinished` early-return

When a real `tool_use` block arrived from Cursor, `finalizeToolUseTurn` fired after a 250 ms debounce (or immediately on `stepCompleted`), set `toolUseFinished = true`, and wrote `message_delta(stop_reason=tool_use)` + `message_stop` + `res.end()` — closing the response. `onTurnEnded`, when it later fired, hit `if (turnState.toolUseFinished) return;` *before* reaching the rescue check. Hallucinated text in the same turn was unrescuable.

### Gate 2: `pendingToolCalls.length === 0`

Even without finalize, the rescue scanner was gated on "zero real tool calls in this turn." Any real tool call → rescue skipped → hallucinated text left as text.

### Gate 3: thinking content invisible to the scanner

`emittedTextForDetection` was populated only by `onTextDelta`. If the model emitted `[Tool call: ...]` inside a thinking block, it went into `emittedThinkingForDetection` (or nowhere) — never scanned.

### The fix

Extracted the rescue body into `tryRescueHallucinatedToolCalls()` — a closure helper inside `buildTurnCallbacks` that:

1. Concatenates both `emittedTextForDetection` and `emittedThinkingForDetection`.
2. Uses a `rescuedHitCount` watermark on `turnState` so it's idempotent — calling it multiple times per turn doesn't re-rescue the same hits.
3. Dedups by `(toolName, args)` against existing `pendingToolCalls`. So if the model emits a real `tool_use` AND a textual `[Tool call: X]` for the *same* call with the same args, we don't synthesize a duplicate.

Called from two sites:

- **Inside `finalizeToolUseTurn`**, *before* `toolUseFinished = true` and the final `message_delta`/`message_stop` writes. This is the mixed-mode case: real tool calls trigger finalize; we run rescue first so synthesized blocks ride out on the same response.
- **Inside `onTurnEnded`** (replacing the old inline block). This handles the text-only-hallucination case where finalize doesn't fire.

### Streaming text suppression

After the structural rescue worked, the bracketed text was *still* visible in claude-code's UI — synthesized `tool_use` blocks ran the tool correctly, but the model's original `[Tool call: ...]` text was already on the wire. New module `src/streaming-hallucination-filter.js` adds a small streaming-text filter:

- Text without `[` flows through immediately.
- Text starting with `[` is held back until the next chars either (a) disambiguate against the `[Tool call: ` prefix → flush, or (b) complete a `[Tool call: NAME({...})]` pattern → drop the matched span, flush surrounding text.
- Latency: at most one delta's worth.
- Bounded buffer (64 KB default) — if a `[` opens but never closes within that, we leak rather than swallow unbounded content.
- The full raw text still goes into `emittedTextForDetection` so the structural rescue sees what to rescue. The filter only suppresses the wire output.

End-to-end: hallucinated `[Tool call: Read({"path":"/foo"})]` → suppressed from the wire → structural rescue synthesizes a `tool_use(Read, {file_path: "/foo"})` → claude-code displays only the tool result. Matches real Claude Code's UX.

19/19 unit tests pass (`src/streaming-hallucination-filter.js` standalone), including the user's reported 3-sequential-identical-patterns case.

---

## Thinking blocks: dropped by default for cross-provider portability

Sessions started via this proxy previously contained `thinking` content blocks in claude-code's stored history *without a valid signature*. Anthropic's extended-thinking spec requires a server-issued cryptographic MAC on every thinking block; without it, the API rejects subsequent requests with `400 messages.N.content.M: Invalid signature in thinking block` when the conversation is resumed.

We cannot forge that signature — only Anthropic can sign — and Cursor's upstream Anthropic provider does not forward the original signatures to us over the `agent.v1.AgentService/Run` protocol. We receive `thinkingDelta` text frames but no companion signature frame.

So:

- **Emit thinking blocks** → sessions are poisoned against direct-Anthropic resume.
- **Drop thinking blocks** → claude-code's `✻ Cogitated for Xs (ctrl+o to expand)` collapsed UI display disappears, but sessions stay portable.

Default is now drop (`_emitThinkingBlocks = false` unless `CURSOR_EMIT_THINKING_BLOCKS=1`). Implementation in `server.js`:

- `onThinkingDelta` always appends to the internal `emittedThinkingForDetection` buffer (so the hallucination rescue still scans thinking content for `[Tool call: ...]` patterns).
- When `_emitThinkingBlocks` is false, the callback returns *before* writing any `content_block_start_thinking` / `content_block_delta_thinking` to the wire.
- Non-streaming responses already never emit thinking blocks (the response builder only includes text + tool_use blocks).

Startup banner shows the current setting: `💭 Thinking blocks: OFF (portable)` / `ON (non-portable)`.

**Functionally lost: nothing** within the proxy path. The model's reasoning still happens upstream at Cursor's provider and influences the visible response text. Cross-turn thinking continuity through this proxy was already non-existent: `anthropicMessagesToPrompt` silently drops thinking blocks on the inbound side (no handler in the type switch at `src/anthropic-converter.js:331-410`), so Cursor never saw prior thinking blocks even when claude-code stored them. The proxy was always thinking-blind on inbound.

**Functionally lost: only the cosmetic UI** in claude-code's display. The model's reasoning still happens; you just don't see it as a collapsed block.

**Functionally gained:** cross-provider portability. Switch `ANTHROPIC_BASE_URL` from this proxy to `api.anthropic.com` mid-session and `claude --continue` works.

---

## ChatService migration — attempted, blocked, reverted

**Record of an investigation, not a feature shipped.** The code that backed
this section was added in commit `868aa95` and removed shortly after when
the blocker below was confirmed. Findings preserved here so the next
person investigating thinking continuity through this proxy doesn't repeat
the discovery loop.

**Goal:** enable cross-turn thinking continuity by switching the proxy's wire transport from `agent.v1.AgentService/Run` to `aiserver.v1.ChatService/StreamUnifiedChatWithTools` — the RPC Cursor IDE itself uses internally for its chat panel. The agent transport strips Anthropic's signed thinking blocks (no signature field exists in its `ThinkingDeltaUpdate` message); the chat transport's `ConversationMessage.Thinking` has explicit `text`, `signature`, `redacted_thinking`, and `is_last_thinking_chunk` fields, preserving signatures end-to-end.

**What we built:**

1. **`src/proto/chat_pb.mjs`** (335 KB, 4839 lines, 365 message types).
   Generated from `/tmp/extract-cursor-protos/cursor/aiserver/v1/aiserver.proto`
   using `protoc` + `@bufbuild/protoc-gen-es`. Transitive closure starting
   from `ChatService` RPCs. Covers `StreamUnifiedChatRequest{,WithTools,
   WithToolsIdempotent}`, `StreamUnifiedChatResponse{,WithTools,...}`,
   `ConversationMessage` (with `Thinking { text, signature, redacted_thinking,
   is_last_thinking_chunk }`), `ClientSideToolV2*` family for tool calls,
   `BuiltinTool` enum, plus all common deps (`ModelDetails`, `CodeBlock`,
   `LinterError`, etc.). Verified roundtrip: signature field survives
   `create → toBinary → fromBinary` cycle.

2. **`src/cursor-chat.js`** — new client module mirroring `cursor-agent.js`'s
   `startConversation()` interface. Hits
   `POST https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools`
   via `application/connect+proto`. Wraps the inner `StreamUnifiedChatRequest`
   in `StreamUnifiedChatRequestWithTools` (which holds the inner at field 1 +
   optional `client_side_tool_v2_result` at field 2 for tool-result feedback).
   Translates Anthropic messages to `ConversationMessage[]` preserving signed
   `thinking` blocks (text + signature) verbatim on inbound; reads the
   response stream, extracts incremental `thinking`/`text` from
   `ConversationMessage` frames, fires `onSignatureDelta` when an
   `is_last_thinking_chunk: true` arrives. Connect-framing decoder (1-byte
   flags + 4-byte BE length + payload) buffers across HTTP/2 chunk
   boundaries.

3. **`buildContentBlockDeltaSignature(index, signature)`** in
   `anthropic-converter.js`. Emits the `signature_delta` SSE event
   Anthropic uses inside a thinking content block:
   `{ type: "content_block_delta", index, delta: { type: "signature_delta",
   signature } }`. claude-code's SDK consumes this and stores the
   signature with the thinking block in its session file.

4. **server.js wiring** — `CURSOR_USE_CHAT_SERVICE=1` opts in. Route picks
   `cursorChat.startConversation` over `cursorAgent.startConversation` when
   the flag is on AND `mcpTools.length === 0` (no registered tools — chat
   service tool envelope is out of scope for v1). Forces
   `forceEmitThinking: true` on the buildTurnCallbacks options so thinking
   blocks ride out on the wire (signatures are real, portable to direct
   Anthropic). Banner shows the setting:
   `💭 Thinking blocks: OFF (portable)` / `ON (non-portable)` — toggles
   based on `_emitThinkingBlocks` semantics.

**What we hit:**

```
[cursor-chat] trailer: {
  "error": {
    "code": "unauthenticated",
    "message": "You are not authorized to use cloud agents in this team.
                Please contact your team admin.",
    "details": [{
      "type": "aiserver.v1.ErrorDetails",
      "debug": {
        "error": "ERROR_UNAUTHORIZED",
        "details": {
          "title": "Unauthorized request.",
          "detail": "You are not authorized to use cloud agents in this team.
                     Please contact your team admin.",
          "isRetryable": false,
          "analyticsMetadata": { "actionRequired": "login" }
        },
        "isExpected": true
      }
    }]
  }
}
```

`isExpected: true` in the debug section is the load-bearing bit: Cursor's
backend deliberately gates access to `aiserver.v1.ChatService.*` (and the
"cloud agents" / Background Composer family it powers) on a team
entitlement that the token we hold lacks. The protobuf request shape was
correct — the server parsed it, validated it, and returned a structured
authorization error rather than a wire-level parse failure.

This is consistent with Cursor's product structure: cloud-side chat history
plus signed-thinking continuity is part of their paid "Background Agents"
feature, billed per team. Tokens minted from a free or unaffiliated account
get a 403-style refusal.

**Why the code was reverted:**

The engineering was structurally complete and would Just Work for an
entitled token, but it added ~5500 lines (mostly the generated proto) to
a repo with no working users. Leaving it dormant is bloat. Cleaner to
remove and reconstruct from this record if/when an entitled token shows
up. The commits to consult:

- `868aa95` — the full migration: proto module, client, wiring, signature
  delta converter, env flag.
- `5ec721f` — the corresponding docs.

Re-add by `git cherry-pick 868aa95 5ec721f` from a branch off that point
if the entitlement is later granted.

**What's still future work even if the entitlement is granted:**

- **Tool support on the chat path.** `ClientSideToolV2*` types were in the proto but the request-side population (mapping Anthropic's `tools[]` to Cursor's per-tool envelopes) wasn't implemented. The reverted client fell back to AgentService for tool turns.
- **Response-side tool extraction.** Decoding tool calls from `ConversationMessage` and synthesizing Anthropic `tool_use` blocks.
- **Tool-result feedback.** The wrapper has a slot (`client_side_tool_v2_result`, field 2) but the per-call wire shape needs reverse-engineering from real Cursor IDE traffic with tools enabled.

**Lesson for future attempts.** Before building a parallel transport, **probe the auth surface with a 10-line throwaway script** — POST an empty Connect-framed body to the target RPC and read the error trailer. A 30-second probe against `aiserver.v1.ChatService` would have surfaced `ERROR_UNAUTHORIZED` immediately and saved the multi-hour proto+client build. The fact that a peer project (JiuZ-Chn) successfully uses the RPC is not generalizable evidence that *your* token will — they have (or had) an entitled account.

---

## Proxy-side thinking re-injection (opt-in approximation)

Since the only transport we can use (`agent.v1.AgentService/Run`) strips Anthropic's signed thinking blocks, and the transport that preserves them (`aiserver.v1.ChatService.*`) is gated on an entitlement the token doesn't have, the model on Cursor's side sees the flattened conversation text on every fresh user turn but not its prior reasoning. This is the gap behind the "no cross-turn thinking continuity through the proxy" caveat that recurred throughout this work.

`src/thinking-history.js` is the proxy-side approximation. When `CURSOR_REINJECT_THINKING=1`:

- After every successful turn, the model's emitted thinking text (already buffered internally for the hallucination rescue at `turnState.emittedThinkingForDetection`) is scrubbed of `[Tool call: ...]` patterns and stored per-conversation, keyed by `convKey`, with bounds (`MAX_BYTES_PER_TURN`=4096, `MAX_TURNS`=5 by default, both env-overridable).
- On every subsequent turn, `anthropicMessagesToPrompt` walks the message history, counts assistant messages, and prepends `<thinking>...</thinking>` to the body of each assistant message whose index has a stored entry. The model sees its own reasoning as visible context inside its prior assistant turns.

What this is **not**: native Anthropic extended-thinking continuity. The model treats injected text as part of the conversation it can reference, not as signed reasoning the server validates. The model on Cursor's side has no notion that "this is *my* prior thinking" — it's just text labeled `<thinking>`. Different mechanism, similar effect for the use cases where it helps.

What this **is** useful for:
- Sequential reasoning questions where turn N+1 references the analytical work of turn N. The model can see its earlier logic and build on it.
- Long-running coding sessions where the model's reasoning chain is itself the artifact (e.g., "now apply that insight to the other file").

What this **is not** useful for:
- Short answers or tool-call-heavy turns where the prior thinking has no bearing on the next question. Pure overhead.
- Cross-provider portability — this is purely proxy-internal state, not reflected in claude-code's stored session.

Defaults are off because the token cost is real (a few hundred to a few thousand tokens per continuation, compounding with conversation length) and the benefit is workload-specific. Storage is in-memory, bounded, and TTL'd at 30 min to match the bridge cache.

Implementation: `src/thinking-history.js` is ~80 lines, integration in `server.js` and `anthropic-converter.js` adds about 30 more. The hallucination-rescue text buffer (`emittedThinkingForDetection`) was already populated regardless of whether thinking blocks reached the wire, so capture-side cost is negligible.

### Cross-implementation study (what others do)

We surveyed how three implementations handle thinking-block continuity, to inform the design of the re-injection strategy above. Findings:

**Cursor IDE — sends ALL prior thinking per request, with signatures verbatim.**

Direct wire-capture evidence in `/tmp/cursor-tap/cursor-reverse-notes-1.md:1925`:

```json
{
  "id": "1",
  "role": "assistant",
  "content": [
    { "type": "reasoning",
      "text": "Now build to verify.",
      "providerOptions": {"cursor": {"modelName": "claude-4.5-opus-high-thinking"}},
      "signature": "ErwBCkYICxgCKkAhMRmRyrCdeWMgxe61O9ZaqQckrofZra..." },
    { "type": "tool-call", "toolCallId": "toolu_012k...", ... }
  ]
}
```

Each assistant turn is stored as an AI SDK-style blob with the full signed reasoning block, alongside the tool calls. On reconnect, the client re-sends `conversationState.turns = [<all blob IDs>]`; the server reconstructs the full transcript. `ConversationSummaryArchive` (proto line 2648) is a last-resort compactor — observed only twice in 80k requests per the cursor-tap notes. Schema reinforces this: `StreamUnifiedChatRequest.conversation` is `repeated ConversationMessage`, and each message has `repeated Thinking all_thinking_blocks = 46`.

Conclusion: Cursor's design is "send everything, summarize only when context is genuinely exhausted."

**claude-code — sends ALL prior thinking from every assistant message in history, verbatim with signatures.**

Storage: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, one JSONL line per streamed content block. Verbatim, full signatures (332–20436 chars observed across sessions). The `lkY()` recombiner in `cli.js` concatenates content blocks from the same `message.id` without dropping thinking. The final `P6A` / `w6A` API builders pass them through unchanged. No filter anywhere in the binary removes `thinking` / `redacted_thinking` from history.

Anthropic's API documentation makes a distinction claude-code does not act on:

> "It is only strictly necessary to send back thinking blocks when using tools with extended thinking. Otherwise, you can omit thinking blocks from previous turns, or let the API strip them for you if you pass them back."

So the protocol is *asymmetric*: within a tool-use chain (model's POV: same assistant turn), thinking MUST be preserved exact-bytes. Across user-facing turns it's OPTIONAL — the server will silently strip them if forwarded. claude-code doesn't make that distinction and just forwards everything (which is why a single bad signature deep in history surfaces as a 400 — Anthropic validates every block, even the optional ones).

The claude-code env vars that DO exist on the thinking surface are all **generation-side**, not storage-side:

- `MAX_THINKING_TOKENS=<N>` — request-side `body.thinking.budget_tokens`. N=0 disables thinking.
- `CLAUDE_CODE_DISABLE_THINKING=1` — strips thinking from the request entirely.
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` — forces explicit budget, disables `type: "adaptive"`.
- `DISABLE_INTERLEAVED_THINKING=1` — disables thinking between tool calls.
- `--effort low/medium/high/xhigh/max` — CLI flag mapping to the same budget.

There is no equivalent of a per-turn storage cap; claude-code stores whatever the model emitted, however large.

The `i_7 = 1024` constant in the binary is the fallback for `countTokens` probes (used during compaction planning), NOT the default for real generation. For real generation, defaults to `type: "adaptive"` for newer models, model picks its own budget per turn — typically thousands to tens of thousands of tokens (~10–60 KB of text for `--effort max` on opus-thinking).

**opencode-cursor — preserves NOTHING.**

Both `/tmp/opencode-cursor` and `/tmp/opencode-cursor-eph` drop thinking from inbound history. `parseMessages` extracts only `type === "text"` parts; `buildCursorRequest` never creates a `ConversationStep{case:"thinkingMessage"}` despite the schema supporting it (`agent_pb.ts:1544-1547`, `ThinkingMessage` at 1879). They forward thinking deltas to the client live as OpenAI-style `reasoning_content` chunks, then forget them. Zero re-injection logic of any kind.

The one related pattern is in the `eph` variant (`src/proxy.ts:633-635`): they cache Cursor's opaque `ConversationStateStructure` checkpoint blob and replay it verbatim on the next request. If Cursor's server-side checkpoint contains thinking, it rides along incidentally — but opencode itself does no management. Not portable to our flow because we hit a different RPC path and `conversationCheckpointUpdate` references per-stream blobs that don't replay.

### Strategic implications for our text-form re-injection

The three-way pattern is consistent but applies to two different worlds:

| Implementation | Strategy | Effective on our path? |
|---|---|---|
| Cursor IDE | Send ALL signed blocks | Not us — we don't have ChatService entitlement, signatures stripped on AgentService |
| claude-code | Send ALL signed blocks | Doesn't apply — we're the *server* claude-code talks to, not the client |
| opencode | Send NOTHING | An honest minimal-overhead choice if we accept losing continuity |
| Us | Inject text-form blocks (proxy-side) | Yes — closest analog to mimicking what they do without signatures |

The key uncertainty: we don't know if the model treats text-form `<thinking>` as comparably useful to signed thinking. Signatures are for API-level integrity (preventing tampering), not for how the model weights the content — so in principle the model might use text-form thinking similarly. But this is unverified.

Architecturally the right move is to mirror the canonical "send what you have" pattern unless we get evidence text-form is weaker. Practically that means: keep all recent turns up to a total-byte budget, drop oldest first when it overflows.

Anthropic's docs actually give us one shortcut: **thinking from older user-facing turns is OPTIONAL.** So if compute/token cost matters, dropping the oldest is safe by Anthropic's spec — exactly what a bounded ring-buffer does.

### Per-turn byte cap re-examined

The default `CURSOR_REINJECT_THINKING_MAX_BYTES_PER_TURN=4096` was set defensively when this feature was first built. Cross-implementation evidence suggests it's too aggressive:

- Typical `claude-opus-4-7-thinking-max` thinking blocks are 10–60 KB per turn (well under the 64K token = ~256 KB ceiling, well over our 4 KB cap).
- claude-code stores them whole; Cursor IDE sends them whole.
- Our 4 KB cap truncates ~80% of a typical block — capturing only the opening paragraph.

A more honest default given the evidence: **16–32 KB per turn**, with a separate global `MAX_TOTAL_BYTES` backstop if a single-conversation budget is needed. The current per-turn cap remains as a "safety valve for outlier turns," not a routine truncation.

---

## convKey collision fix (2026-05-14)

### The collision class

`deriveConversationKey` and `deriveBridgeKey` hashed `(modelId, systemFingerprint, firstUserText.slice(0,200), remoteAddr, remotePort, toolHash)`. The remoteAddr+remotePort salt was added to defend against two concurrent claude-code processes sharing a host — port is normally distinct per process keep-alive socket. But the defense leaks under two real conditions:

1. **Same prompt, same socket.** Claude Code reuses a single keep-alive socket within a session, but at the *Node HTTP server* level, multiple in-flight requests on one TCP connection report the *same* `remotePort` (the client port doesn't change per request). If a user fires `claude -p "foo"` twice from the same host in close succession and connection reuse picks up, the two POSTs land on the same socket → same port → same firstUserText → **identical convKey**.

2. **Tool-result race.** When the model emits a tool_use, claude-code POSTs the tool_result on the same socket. The bridgeKey lookup happens on that POST — if the proxy has another fresh conversation cached under the same key, the tool_result routes to the wrong stream and the original conversation hangs (we've seen this manifest as stuck "thinking" indicators that never resolve).

The colleague flagged this with a concrete reproducer: two simultaneous prompts → both keyed identically → second overwrites first's bridge entry → first's continuation goes to the wrong H2 stream.

### The signal we found

Empirical capture via a transparent HTTP tap (`/tmp/tap.js`, sits between claude-code and our proxy and logs every request) revealed that claude-code sends two headers carrying a stable per-conversation UUID:

| Source | Path | Notes |
|---|---|---|
| `x-claude-code-session-id` | direct header | UUIDv4, stable for the lifetime of one claude-code session |
| `body.metadata.user_id` | JSON-encoded string with `{device_id, account_uuid, session_id}` | session_id field carries the same UUID as the header |

Verified properties from 3 parallel `claude -p` runs with identical prompts:
- Within one session, every POST (initial + each tool_result continuation) carries the same UUID.
- Across two separate `claude -p` invocations, the UUIDs are distinct even with identical prompts, identical remoteAddr, and overlapping wall clock.

### The fix

`extractClientSessionId(req)` (in `src/anthropic-tools.js`) returns the header if present, otherwise parses `body.metadata.user_id` as JSON and pulls `.session_id`. `deriveConversationKey` and `deriveBridgeKey` now accept this id as an additional argument; when present they produce `sha256("conv-v2:" + modelId + ":" + sessionId)` / `sha256("bridge-v2:" + modelId + ":" + sessionId)`. The `-v2:` namespace prevents accidental aliasing with old cache entries during rollout.

The fallback path (no session id) is preserved unchanged for non-claude-code callers (opencode, raw API clients), so this change is purely additive.

### Verification

- 25-assertion unit test (`/tmp/test-conv-key.js`): covers v1 determinism, v2 ignores port/addr but respects sessionId, v2 namespace doesn't alias v1, bridgeKey distinct from convKey, all extract paths (header/body/null/garbage).
- End-to-end smoke test: two parallel `claude -p "echo parallel test 1"` invocations produce two distinct session UUIDs (`1a9c0a28-…` / `a3d50cf3-…`) → two distinct convKeys, observed in proxy log and confirmed by hashing the captured session ids through the public function.
- Without sessionId (legacy fallback), the same inputs collide as expected — proves the bug existed and is now skipped by the v2 path.

### Why not just include sessionId in the salt of the existing key?

Considered. Rejected because:
- Mixing the optional sessionId into the same hash with the always-present (`firstUserText`, etc.) inputs makes "did we use the session id?" un-observable from the wire — debugging two collided conversations becomes ambiguous.
- A separate v2 namespace makes the rollout cache-safe: existing in-flight conversations under v1 keys keep resolving correctly while new conversations from claude-code start using v2.

---

## convKey v2 subagent regression (2026-05-15)

The first cut at the v2 convKey path (commit `b879706`) hashed only `(modelId, clientSessionId)`. This fixed cross-session collisions (the original colleague-reported bug) but introduced a *within-session* collision: when claude-code spawns a `WebSearch` or `Task` subagent it issues a fresh `/v1/messages` POST with the same `x-claude-code-session-id` as the parent, a different first user prompt, and a different (typically much smaller) tool set. Both POSTs hashed to the same v2 convKey/bridgeKey. The subagent's `bridgeKey=parent` lookup hit the parent's open H2 stream → the parent's `tool_use_id` continuation routed onto the subagent's stream → user-visible symptom was `Web Search(…) ⎿ Did 0 searches in 8s` followed by a 2m+ stall.

Fix: salt the v2 hash with `firstUserText + toolHash` as well. Within one claude-code conversation, the first user message stays stable across continuation turns, so the parent's convKey stays stable. The subagent has a different first user message (and usually a single-tool set), so it gets a distinct convKey. Cross-session defense is unaffected — distinct sessionIds still dominate.

```
conv-v2: sha256("conv-v2:" + modelId + ":" + sessionId + ":" + firstUserText(0..200) + ":" + toolListHash)
```

Verified empirically with `claude -p ... --allowed-tools WebSearch`: parent convKey `b801d20f...` and WebSearch subagent convKey `ce6d05fe...` diverge as required; the parent's continuation POST (`toolResults=1`) reuses the parent's convKey and the turn completes with the search result returned through. Unit test (`/tmp/test-conv-key.js`, 28 assertions) covers: parent ≠ subagent same-session, parent-turn-2 == parent-turn-1, cross-session still distinct, v1 fallback unchanged.

---

## MCP resource discovery handler (2026-05-15)

### Symptom

In a session that fired several `WebSearch` tool_use blocks (claude-code routes WebSearch through a `Task` subagent — a fresh conversation with `tools=1`), the proxy log showed:

```
[cursor-agent] unhandled exec case=listMcpResourcesExecArgs execId=…
```

The subagent's turn never reached `turnEnded`. The user filed it as "WebSearch seems not supported?" — actually WebSearch was fine (it routed back to claude-code as a normal tool_use); the stall was the *Cursor model inside the subagent* probing for MCP resources and not getting a reply.

### Root cause

`handleExecMessage` in `src/cursor-agent.js` had branches for the common exec cases (read/ls/write/delete/shell/shellStream/backgroundShellSpawn/grep/fetch/writeShellStdin/diagnostics + the mcpArgs bubble-up) but no branch for `listMcpResourcesExecArgs` or `readMcpResourceExecArgs`. The unhandled cases fell to the default `console.log('unhandled exec case=…')` and returned without sending a reply. Cursor's model treats no-reply as "client is still working" — the BiDi stream waits forever.

### Fix

Two new branches in `handleExecMessage`:

- `listMcpResourcesExecArgs` → reply with `ListMcpResourcesExecResult { success: { resources: [] } }`. We host zero MCP resource servers, so empty success is the honest answer.
- `readMcpResourceExecArgs` → reply with `ReadMcpResourceExecResult { notFound: { uri } }`. List returns empty so the model shouldn't issue these, but a confused model issuing them anyway should get a fast `not_found` instead of stalling.

Verified by unit test that exercises both paths through `_handleExecMessage` (a test-only export added on `src/cursor-agent.js`): correct oneof case selected, expected payload echoed.

---

## Vendored proto regen — root cause of `input_schema` silent drop (2026-05-15)

Regenerated `src/proto/agent_pb.mjs` from `/tmp/cursor-tap/cursor_proto/agent_v1.proto` via `protoc-gen-es` to pick up `WebFetchRequestQuery` / `WebFetchRequestResponse` (proto fields 9 in InteractionQuery/Response — absent from the previous v2.10.2 generation, which caused the existing `case 'webFetchRequestQuery'` handler in `handleInteractionQuery` to be dead code; the model's WebFetch interactions fell through to the default abandon path with `interactionQuery case=undefined id=N` log spam).

First-pass regen broke baseline `claude -p` with consistent 60s+ timeouts even though wire bytes for every message we *send* were byte-identical between old and new proto and direct `curl` against `/v1/messages` worked. Root cause was a schema-definition difference for `McpToolDefinition.input_schema`:

- **Old `.proto` (vendored)**: `bytes input_schema = 3;`
- **New `.proto` (current upstream)**: `google.protobuf.Value input_schema = 3;`

Our code at `cursor-agent.js:483` pre-encoded the JSON Schema into raw `Value` bytes via `toBinary(wkt.ValueSchema, fromJson(...))` and passed those bytes as `inputSchema`. With the old `bytes`-typed field, that's exactly what proto-es expects. With the new `Value`-typed field, proto-es expects a Value MESSAGE OBJECT and **silently drops the field when handed a Uint8Array** — no error, no warning, just a 0-length encoding for the field. The 51 tools we send to Cursor end up with empty input schemas → Cursor's model can't invoke them → turn never produces text → claude-code times out.

Verified by a minimal round-trip:

```
raw input_schema bytes: 67
OLD proto McpToolDefinition encoded: 87 bytes (schema included)
NEW proto McpToolDefinition encoded: 20 bytes (schema DROPPED)
NEW proto with Value object: 87 bytes (schema included, identical to OLD)
```

Fix: `buildMcpToolDefinitions` now produces a `Value` object (`fromJson(wkt.ValueSchema, schema)`) instead of raw bytes. The legacy `inputSchema: Uint8Array` caller shape is preserved by decoding the bytes back into a `Value` via `fromBinary`. Both paths now feed proto-es a Value object, which works under both the old and new schema definitions (proto3 wire-compat: a `Value`-typed field and a `bytes`-typed field with serialized Value content produce identical bytes when the value is present).

End-to-end verification: `claude -p "use WebSearch ..." --dangerously-skip-permissions` now completes; proxy log shows zero `unhandled exec` events and zero `interactionQuery case=undefined` abandons. The model's WebFetch interactionQueries are now properly recognized as `webFetchRequestQuery` and rejected via the existing handler (which causes the model to fall back to MCP-prefixed equivalents).

### Round 2: `decodeMcpArgs` had the same bytes-vs-Value mismatch

After the schema regen unblocked WebFetch tool definitions, the MODEL's `mcp_WebFetch` calls started failing in claude-code with `Invalid tool parameters`. Same proto change, opposite direction:

- old .proto:  `map<string, bytes> args = 2;`            (values arrive as Uint8Array of Value bytes)
- new .proto:  `map<string, google.protobuf.Value> args = 2;`  (values arrive as parsed Value proto objects)

`decodeMcpArgs` checked `instanceof Uint8Array` / `typeof === 'string'` / else "already a JS value". The else branch passed the raw Value proto object through unchanged. claude-code received `{url: {kind: {case: 'stringValue', value: 'https://...'}}}` instead of `{url: 'https://...'}` and its MCP validator rejected.

Fix: when the map value is a Value proto message (detected by `obj.kind.case`), unwrap via `toJson(wkt.ValueSchema, v)`. Bytes / base64 / Uint8Array paths preserved for backward compat. Both wire shapes now produce identical plain JS values.

Verified end-to-end: `claude -p "use WebFetch to fetch https://example.com..." --dangerously-skip-permissions` completes, model gets real page content, no `Invalid tool parameters` errors. Tool calls in the log show clean JSON args, e.g. `WebFetch({"url":"https://example.com","prompt":"What is on this page?"})`.

**Investigation aside**: the original hypothesis that the `interactionQuery case=undefined` log flood was *causing* user-visible stalls was wrong. The original reproducer log shows 10 abandons inside a subagent turn that nevertheless ended successfully with 866 output bytes. The user-visible stall in that case was a Cursor-backend `Upstream stalled — no progress for 165s` event on the parent's `tool_result` roundtrip, handled by our existing watchdog retry. The abandon noise was cosmetic.

---

## WebFetch works through proxy; WebSearch is architecturally blocked (2026-05-16)

After the proto regen + the two bytes↔Value fixes (encode + decode), end-to-end behavior settled into a clear split:

**WebFetch — works fully through the proxy.** Direct URL fetch, no search backend needed. Verified by `claude -p "use WebFetch to fetch https://github.com/slopus/happy ..." --dangerously-skip-permissions` returning real page content (335,960 bytes from the live page) and the model parsing it to report the real star count.

**WebSearch — fails with `searchCount: 0` regardless of proxy state.** claude-code's `WebSearch` is an Anthropic-server-side tool: it talks directly to Anthropic's search backend, not via the model's MCP/tool-use path. With `ANTHROPIC_BASE_URL=our-proxy`, claude-code's WebSearch HTTP client points at our proxy → our proxy forwards to Cursor → Cursor has no concept of Anthropic's search backend → WebSearch reports `searchCount: 0` and "no web search capability configured." The proxy cannot fix this — it's an architectural mismatch.

Practical workarounds for real web search through this stack:
- Wire an MCP web-search server (Brave Search MCP, SerpAPI MCP, etc.) into claude-code's `~/.claude/mcp_servers.json` or `.mcp.json`. Those calls traverse as standard MCP tool calls through our proxy and work end-to-end.
- Use `WebFetch` for direct URL fetches when you already know the URL.

**Earlier misclaim**: in a prior turn I read "Eiffel Tower stands 330 meters..." output from `claude -p "use WebSearch..."` as evidence that WebSearch worked end-to-end. It didn't — the model's own tool_result text explicitly included "(Note: Web search tools were unavailable in this environment, so this answer is from general knowledge rather than a live search)" and I missed that line. Knowledge-based answers from the model are not proof of tool function. When verifying a tool, check the `toolUseResult` block in the session JSONL (`/root/.claude/projects/.../*.jsonl`) for the actual `searchCount`/`results`/`bytes` — that's the ground truth, not the model's prose output.

---

## Future work / open issues

- **opencode integration**: opencode reaches the proxy but Cursor's auto-injected system prompt overrides opencode's framing. The model ends up confused about its identity. A possible fix: detect the opencode-style request and strip Cursor's blob before forwarding (or force-replace it with our own).
- **Parallel tool calls**: The 250 ms debounce on `mcpArgs` is a heuristic. For models that call many tools in parallel (Claude can issue 5+ in one turn), this could miss some. Consider replacing with a more explicit signal — `interactionUpdate.toolCallStarted` arrives before `mcpArgs` and could be used to pre-arm the debounce.
- **`anthropic-beta` header forwarding**: copilot-api passes through specific betas (`interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, `advanced-tool-use-2025-11-20`). We currently ignore them. Some Claude features may not work without them.
- **Cursor IDE's exact wire format**: We never did a side-by-side comparison of an actual Cursor-IDE-generated request vs. ours, only reasoned from the proto definitions and the working reference. If something breaks after a Cursor update, capture a real IDE request via mitmproxy and diff against `agent_pb.mjs`.
