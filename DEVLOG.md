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

## Conversation/bridge cache keys

We maintain two in-memory caches on the proxy:

- `conversationStates` keyed by `convKey = sha256("conv:" + modelId + ":" + firstUserText.slice(0,200))` — stores the opaque protobuf checkpoint Cursor sends back via `conversationCheckpointUpdate`. Used to resume a conversation across HTTP request boundaries.
- `activeBridges` keyed by `bridgeKey = sha256("bridge:" + modelId + ":" + firstUserText.slice(0,200))` — stores the open H2 stream + pending exec list. Used to route `tool_result` follow-ups back to the same Cursor stream.

**Both keys include `modelId`.** Earlier we made `convKey` model-independent and immediately hit `Connect error internal: Blob not found`: switching from opus to sonnet would replay opus's checkpoint blobs into a sonnet conversation, which Cursor's blob store doesn't have under that conversationId. Including modelId isolates each model's state and fixes the issue.

Both caches expire after 30 minutes of inactivity. There's no eviction on graceful turn end except when there are no pending tool calls — bridges with pending tool results are kept alive for the client's continuation POST.

---

## Future work / open issues

- **opencode integration**: opencode reaches the proxy but Cursor's auto-injected system prompt overrides opencode's framing. The model ends up confused about its identity. A possible fix: detect the opencode-style request and strip Cursor's blob before forwarding (or force-replace it with our own).
- **Parallel tool calls**: The 250 ms debounce on `mcpArgs` is a heuristic. For models that call many tools in parallel (Claude can issue 5+ in one turn), this could miss some. Consider replacing with a more explicit signal — `interactionUpdate.toolCallStarted` arrives before `mcpArgs` and could be used to pre-arm the debounce.
- **`anthropic-beta` header forwarding**: copilot-api passes through specific betas (`interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, `advanced-tool-use-2025-11-20`). We currently ignore them. Some Claude features may not work without them.
- **Cursor IDE's exact wire format**: We never did a side-by-side comparison of an actual Cursor-IDE-generated request vs. ours, only reasoned from the proto definitions and the working reference. If something breaks after a Cursor update, capture a real IDE request via mitmproxy and diff against `agent_pb.mjs`.
