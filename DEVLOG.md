# DEVLOG — Anthropic API + Tool-Use Support

A working notebook of what we learned reverse-engineering Cursor's `agent.v1.AgentService/Run` enough to bridge the Anthropic Messages API (with full tool-use round-trip) on top of it. Written after the work was done; if you are continuing this you should be able to skip several days of dead ends by reading this first.

## TL;DR

1. The proxy speaks `application/connect+proto` (binary protobuf). Connect+JSON works for simple chat but breaks tool registration silently.
2. Cursor's upstream Anthropic provider rejects requests where any MCP tool name collides with Cursor's built-in agent-mode tool surface (14 confirmed names: `Read`, `Write`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Shell`, `Delete`, `Task`, `TodoWrite`, `AskQuestion`, `ListMcpResources`, `ReadLints`, `SwitchMode`). **Always prefix the wire-level `McpToolDefinition.name` with `mcp_`** while leaving `tool_name` unchanged.
3. Cursor's error envelope hides the real cause inside `error.details[].debug.details.detail`. Top-level `error.message` is often the literal string `"Error"`. Walk the trailer.
4. The Cursor stream stays paused after emitting `mcpArgs` — it will NOT fire `turnEnded` until we send `mcpResult`. So when bridging to Anthropic semantics we have to *synthesize* `stop_reason=tool_use` ourselves (we use a 250 ms debounce to batch parallel tool calls).
5. Cursor's KV blob channel must be ACKed (both `setBlobArgs` → `setBlobResult: {}` and `getBlobArgs` → `getBlobResult` with whatever we cached). Without this the model just sits there idle.
6. Verified end-to-end through `claude -p` with `claude-opus-4-7`, `claude-sonnet-4-6`, and `claude-haiku-4-5`. Tool-use round-trip works.

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

- [`ephraimduncan/opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor) — the working TypeScript reference proxy. Read its `src/proxy.ts` if anything here is unclear.
- [`burpheart/cursor-tap`](https://github.com/burpheart/cursor-tap) — packet-capture-based reverse engineering, source of the proto definitions in `cursor_proto/agent_v1.proto` (4345 lines).
- [Connect protocol spec](https://connectrpc.com/docs/protocol) — frame format, end-stream trailers.
- [`@bufbuild/protobuf` docs](https://github.com/bufbuild/protobuf-es) — runtime we use for proto encode/decode.
- This repo's `Cursor IDE API 逆向工程文档.md` — older Chinese-language reverse engineering notes (predates the connect+proto migration but still useful for non-tool flows).

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

- `activeBridges` keyed by `bridgeKey = sha256("bridge:" + modelId + ":" + firstUserText.slice(0,200))` — stores the open H2 stream + pending exec list. Used to route `tool_result` follow-ups back to the **same** Cursor stream. This works.
- `conversationStates` keyed by `convKey = sha256("conv:" + modelId + ":" + firstUserText.slice(0,200))` — was supposed to cache the opaque protobuf checkpoint Cursor sends back via `conversationCheckpointUpdate`, so a fresh `/v1/messages` request could resume a previous conversation without re-uploading context. **This does not work** — Cursor's KV blob store is scoped per-H2-stream, not per-conversation-id. Replaying a saved checkpoint on a fresh stream causes `Connect error internal: Blob not found` because the stored blob hashes only existed in the closed stream.

**Current behavior:** every fresh `/v1/messages` request starts with empty `conversationState`. Cursor rebuilds its blob store from `setBlobArgs` (system prompt, etc.) and the client re-supplies the message history in the prompt anyway. The `conversationStates` Map is preserved as scaffolding for a future architecture where we share an H2 client across requests, but it's not currently populated.

Bridge cache expires after 30 minutes of inactivity. Bridges with pending tool calls are kept alive for the client's continuation POST.

---

## Future work / open issues

- **opencode integration**: opencode reaches the proxy but Cursor's auto-injected system prompt overrides opencode's framing. The model ends up confused about its identity. A possible fix: detect the opencode-style request and strip Cursor's blob before forwarding (or force-replace it with our own).
- **Parallel tool calls**: The 250 ms debounce on `mcpArgs` is a heuristic. For models that call many tools in parallel (Claude can issue 5+ in one turn), this could miss some. Consider replacing with a more explicit signal — `interactionUpdate.toolCallStarted` arrives before `mcpArgs` and could be used to pre-arm the debounce.
- **`anthropic-beta` header forwarding**: copilot-api passes through specific betas (`interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, `advanced-tool-use-2025-11-20`). We currently ignore them. Some Claude features may not work without them.
- **Cursor IDE's exact wire format**: We never did a side-by-side comparison of an actual Cursor-IDE-generated request vs. ours, only reasoned from the proto definitions and the working reference. If something breaks after a Cursor update, capture a real IDE request via mitmproxy and diff against `agent_pb.mjs`.
