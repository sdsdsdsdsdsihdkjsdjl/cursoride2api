# Handover: Local-Proxy Mode (Follow-up PR)

> **You are picking up where another Claude Code session left off.** The current PR (`feat/anthropic-api-support` against `sdsdsdsdsdsihdkjsdjl/cursoride2api`) is complete and tested — its work is in place on disk and pushed. This document describes the **next** initiative: a separate PR adding a "local mode" that eliminates the N+1 HTTP-request pattern by running a server-side agent loop with proxy-executed tools.
>
> Read this entire document before doing anything. After reading, you should plan via a multi-agent team (concrete instructions at the bottom).

---

## TL;DR

`cursoride2api` is a reverse-engineered proxy that exposes Cursor's `agent.v1.AgentService/Run` as Anthropic Messages API + OpenAI Chat Completions. It works. Today's deployment topology is `[Claude Code on laptop] → [proxy on remote server] → [api2.cursor.sh]`. Each tool call from the model causes one HTTP round-trip across all three machines (Anthropic protocol's N+1 pattern). Cursor IDE itself doesn't have N+1 because its agent loop runs server-side over a single H2 stream.

**Your task:** add an opt-in `LOCAL_AGENT=1` mode where the proxy runs on the user's local machine, executes tools (Read/Write/Bash/Glob/Grep) itself instead of returning `tool_use` blocks to the client, and streams a single final Anthropic-shaped response. One HTTP request per user prompt. Same end-result as Cursor IDE.

This is **non-trivial**. It needs to coexist with the existing remote-mode behavior, security implications need to be handled carefully, and tool implementations need parity with Claude Code's expectations.

---

## Where everything lives

### The repo you'll be working in

```
/root/git_farm/cursoride2api/   # current PR target
├── server.js                   # Express, /v1/messages handler, conversation cache
├── src/
│   ├── cursor-agent.js         # connect+proto client to Cursor (the meat)
│   ├── cursor-client.js        # legacy connect+json client for /v1/chat/completions
│   ├── anthropic-converter.js  # SSE event builders, message parsing
│   ├── anthropic-tools.js      # Anthropic↔MCP tool conversion + bridgeKey/convKey hashing
│   ├── preprocess.js           # compaction/subagent/IDE-tool detection (recent addition)
│   ├── debug-log.js            # opt-in JSON file logging
│   ├── config.js               # model name mapping
│   └── proto/agent_pb.mjs      # vendored compiled protobuf schemas (from opencode-cursor)
├── DEVLOG.md                   # comprehensive notes on every wire-format finding
├── README.md
├── HANDOVER_LOCAL_MODE.md      # this file
└── token.json                  # Cursor credentials (gitignored)
```

The current branch `feat/anthropic-api-support` has commits up to and including the compaction/subagent/IDE-tool work. PR is at https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api/pull/1.

### Reference repos (already cloned locally — read these)

The complete Cursor RE reference catalog (every repo we've consulted, adopted, or skipped, plus the local `/tmp/` working-copy paths) lives at [REFERENCES.md](REFERENCES.md). The four hot paths most relevant to a handover:

| Path | Purpose |
|---|---|
| `/root/git_farm/opencode/packages/opencode/src/tool/` | **Open-source tool implementations.** Read/Write/Edit/Bash/Glob/Grep, all in TypeScript with the Effect library. ~2000 LOC total across these tools. Source you'll port from. MIT licensed. |
| `/tmp/opencode-cursor-eph/src/proxy.ts` | Reference Cursor proxy that already does some of what you need (agent loop, exec dispatch). Read-only — do not modify. |
| `/tmp/cursor-tap/cursor_proto/agent_v1.proto` | Full Cursor protobuf definitions (4345 lines). Authoritative spec for the wire format. |
| `/root/git_farm/copilot-api/` | The Copilot proxy we ported preprocessing from. Look at it for *patterns*, not for agent-loop logic — Copilot has no equivalent. |

### Public references

- [Cursor IDE API reverse-engineering doc](https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api/blob/main/Cursor%20IDE%20API%20%E9%80%86%E5%90%91%E5%B7%A5%E7%A8%8B%E6%96%87%E6%A1%A3.md) — Chinese, in this repo
- [`@bufbuild/protobuf` docs](https://github.com/bufbuild/protobuf-es) — runtime we use for proto encoding
- [Connect protocol spec](https://connectrpc.com/docs/protocol) — frame format
- [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) — alternative TypeScript proxy, the original of `/tmp/opencode-cursor-eph`
- [Anthropic tool-use docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview) — for understanding what schemas Claude Code uses

---

## Background: what the current proxy already does

You **must** read `DEVLOG.md` in this repo. It's a comprehensive working notebook. The most important sections:

1. **Architecture diagram** — shows the existing remote-proxy flow with bridge cache and 250ms debounce.
2. **Wire-format facts** — every bit of binary protobuf trickery (`mcp_` prefix on tool names, KV blob handshake, shellStream vs shellResult, etc.). The new mode reuses all this — you must NOT break it.
3. **The error message decoding** — Cursor wraps real errors in `details[].debug.details.detail`. If you see `Connect error resource_exhausted`, walk that chain.
4. **Conversation/bridge cache keys** — both keyed by `(model, first200CharsOfFirstUserText)`. Both include modelId; if you make convKey model-independent you'll hit `Blob not found`.
5. **Tool-budget knobs / Request preprocessing** — env vars that fine-tune behavior.
6. **Dead ends section** — list of things we tried that don't work. Don't repeat them.

Also note the empirical Cursor-native blocked tool name list — 14 PascalCase names — and our solution: **always prefix MCP tool names with `mcp_`**. This is in `cursor-agent.js:buildMcpToolDefinitions`.

---

## The problem you're solving

### The N+1 round-trip pattern

For one Claude Code task like "describe verify_1.png", the user sees:

```
Claude Code (laptop) ↔ Proxy (remote) ↔ api2.cursor.sh
   POST /v1/messages →                       runRequest →
                                          ← mcpArgs(Read)
   ← tool_use(Read)
   POST + tool_result →                    mcpResult →
                                          ← mcpArgs(Bash)
   ← tool_use(Bash)
   POST + tool_result →                    mcpResult →
   ...                                     turnEnded
```

5+ POSTs from laptop to remote proxy. Each costs network latency. Cursor IDE doesn't have this because the IDE's agent loop runs server-side over **one** open H2 stream.

The current proxy's `activeBridges` cache keeps **the proxy↔Cursor leg** as one stream — that's already optimal. What it can't do is collapse the **laptop↔proxy** leg, because Anthropic API protocol requires Claude Code to receive `tool_use` blocks, execute locally, and send `tool_result` blocks back.

### The solution: server-side agent loop with locally-executed tools

If the proxy is **on the user's local machine** and knows how to execute tools itself, it can:
1. Receive ONE `/v1/messages` POST from Claude Code with the user's prompt + tool definitions
2. Open the H2 stream to Cursor and run the entire agent loop
3. When Cursor's model emits `readArgs`/`shellArgs`/etc., **execute them locally** (read user's files, run shell on user's machine) instead of returning to Claude Code
4. Return ONE final Anthropic-shaped response with the accumulated text content

This is exactly what Cursor IDE does, just with Claude Code as a thin TUI on top. **Tools are local** — no security regression vs Cursor IDE itself.

### Critical constraint: only works when the proxy is local

If the proxy is on a remote server, `Read /home/user/foo.txt` reads the *server's* filesystem, which is wrong. So this mode is opt-in via `LOCAL_AGENT=1` and intended to be used with the proxy running as `npm start` on the user's laptop. Document this clearly.

---

## What needs to be built

A new mode, gated on `LOCAL_AGENT=1` env var. When enabled:

### 1. Local tool executors (`src/local-tools.js`, new file)

Implementations of Cursor's native tools that execute on the local machine. Match Cursor's wire types:

| Cursor `*Args` field | Implementation needed | Returns `*Result` shape |
|---|---|---|
| `readArgs { path, toolCallId }` | Read file content; handle binary detection; return image bytes for PNG/JPEG | `readResult.success { path, content/data, totalLines, fileSize }` |
| `writeArgs { path, fileText, toolCallId }` | Write file; create dirs | `writeResult.success { path, linesCreated, fileSize }` |
| `lsArgs { path, ignore, toolCallId, timeoutMs }` | List dir tree | `lsResult.success { directoryTreeRoot { absPath, childrenDirs, childrenFiles, ... } }` |
| `shellArgs { command, workingDirectory, timeout, toolCallId, isBackground, ... }` | Run shell with timeout, capture stdout/stderr/exit | `shellResult.success { command, workingDirectory, exitCode, stdout, stderr, executionTime }` |
| `grepArgs { pattern, path, glob, outputMode, caseInsensitive, ... }` | Grep (use ripgrep if available, fallback to fs walk) | `grepResult.success.workspaceResults` |
| `deleteArgs { path }` | Unlink file | `deleteResult.success` |
| `diagnosticsArgs { path }` | Empty result (no LSP integration in v1) | `diagnosticsResult.success { diagnostics: [] }` |

**Source to port from:** `/root/git_farm/opencode/packages/opencode/src/tool/{read,write,edit,shell,glob,grep}.ts`. opencode's implementations are in TypeScript with Effect. Strip the Effect plumbing and you have plain async functions — the algorithms (line numbering for read, command parsing for shell, etc.) port cleanly.

The exact wire shapes (`*Result.success` field structure) are in `/tmp/cursor-tap/cursor_proto/agent_v1.proto` lines 10–4280. Match these.

**Edit** (no `editArgs` in Cursor's proto — Cursor uses Read+Write or shell-based sed) — for v1, you can probably skip; if needed, implement as Read+search/replace+Write internally.

### 2. Update `src/cursor-agent.js`

In `handleExecMessage`:
- Currently rejects native tool calls with typed `rejected: { reason }` (forces model to fall back to MCP tools).
- When `LOCAL_AGENT=1`, instead **execute the tool locally** via `local-tools.js` and send the typed `*Result.success` back on the same Cursor stream.
- Keep MCP tool handling (`mcpArgs`) exactly as-is — those are still client-defined tools the proxy doesn't know how to execute.

### 3. Update `server.js` `/v1/messages` handler

When `LOCAL_AGENT=1`:
- Don't pass `tools` to Cursor as MCP tools. Cursor's model will use its native `readArgs`/`shellArgs`/etc., which our local executors handle.
- Don't return `tool_use` blocks to the client. Wait for `turnEnded` and return one final response.
- Bridge cache (`activeBridges`) still useful for streaming responses to the client during the long single turn — adapt or simplify.

### 4. Documentation

- README: new section "Local mode" with security warning (proxy executes shell commands on the host machine).
- DEVLOG: add a section describing the architecture change, mirror the diagram from this handover.

### 5. Tests

- Unit tests for each local tool (read, write, bash, glob, grep).
- Integration test with `claude -p` — measure HTTP request count from Claude Code (should be 1 for any single-prompt task).

---

## Topology & security

```
Local mode (LOCAL_AGENT=1):
  [Same machine: laptop]
  ┌──────────────────────────────────────────────┐
  │  Claude Code → proxy → api2.cursor.sh        │
  │  proxy executes Read/Write/Bash on local fs  │
  │  ONE /v1/messages roundtrip per user prompt  │
  └──────────────────────────────────────────────┘

Remote mode (default — current):
  [Laptop]                  [Remote server]            [Cursor]
   Claude Code ───────────►   proxy ───────────►   api2.cursor.sh
                              (tools execute on Claude Code,
                               proxy passes tool_use through)
   N+1 roundtrips per user prompt
```

**Security:** in local mode the proxy runs arbitrary shell commands and reads/writes files as the user. This is no different from Claude Code itself or Cursor IDE — they all do that — but document it loudly. Consider:
- Optional `LOCAL_AGENT_ALLOWED_PATHS` env var to restrict reads/writes to a workspace
- Optional `LOCAL_AGENT_BASH_ALLOWLIST` for command prefix filtering
- Default-deny dangerous patterns? (`rm -rf /`, etc.) — copilot-api's `sandbox-policy` proto field has hints

In v1, just match Cursor IDE's "no sandbox" behavior and rely on the user's trust that they're running this on their own machine. Make security gates a v2 enhancement.

---

## What you must NOT break

The existing remote-mode behavior (default when `LOCAL_AGENT` is unset) must keep working unchanged. Specifically:

- `/v1/messages` MCP-tool path (the entire current flow)
- `/v1/chat/completions` OpenAI-compat path
- `/v1/models`
- The connect+proto wire format, mcp_ prefix, KV blob handshake — all of it
- The bridge cache for tool round-trips
- The compaction/subagent preprocessing
- The debug log / DEBUG_LOG mode
- All env vars: `TOOL_INCLUDE`, `TOOL_LIMIT`, `TOOL_DESC_LIMIT`, `TOOL_SCHEMA_TRIM_BYTES`, `SMALL_MODEL`, `SUBAGENT_USE_SMALL_MODEL`, `DEBUG_LOG`, `CURSOR_AGENT_DEBUG`

The new mode is purely additive. It shares the same proto encoding / Cursor wire stack with remote mode.

---

## Plan via multi-agent team

You should plan this as parallelizable work. After you finish reading this doc, **do not start coding immediately**. Instead:

### Stage 0: Confirm understanding
- Read `DEVLOG.md` cover-to-cover
- Read `src/cursor-agent.js` (the protobuf client)
- Read 100-line samples of `/root/git_farm/opencode/packages/opencode/src/tool/{read,write,shell,grep,glob}.ts` to gauge porting effort
- Read `/tmp/cursor-tap/cursor_proto/agent_v1.proto` lines 10–500 to see the `*Args` / `*Result` message shapes you need to construct

### Stage 1: Multi-agent fan-out (parallel — can all run simultaneously)

Dispatch these as separate agents at the same time:

**Agent A: Port `read.ts` and `write.ts` to plain JS** (`src/local-tools.js`)
- Strip Effect wrappers; output plain async/await functions
- Match opencode's behavior: line numbering, binary file detection, image base64, max-bytes truncation
- Wire to Cursor's `readResult.success` / `writeResult.success` shapes from agent_v1.proto

**Agent B: Port `shell.ts`** (same file)
- Strip Effect; use Node's `child_process.execFile`
- Match opencode's timeout handling, output capture, exit code propagation
- Wire to Cursor's `shellResult.success` shape

**Agent C: Port `glob.ts` and `grep.ts`** (same file)
- Glob: `globby` package or fs walk
- Grep: try `ripgrep` first (best output), fall back to fs walk regex
- Wire to Cursor's `grepResult.success.workspaceResults` shape

**Agent D: Add `LOCAL_AGENT` switch in `cursor-agent.js`**
- In `handleExecMessage`, when `LOCAL_AGENT=1`, route native tool calls to `local-tools.js` instead of rejecting
- Async since local tool execution is async; use the existing bridge `req.write` to send results

**Agent E: Update `server.js` `/v1/messages` flow**
- When `LOCAL_AGENT=1`: don't translate Anthropic tools to MCP, don't expect `tool_use` round-trips from client; wait for `turnEnded` and return one final response with all accumulated text
- When unset: existing behavior

**Agent F: Add tests + update docs**
- Unit tests for each local tool
- Integration test (`claude -p` with `LOCAL_AGENT=1` — measure roundtrip count)
- README "Local mode" section
- DEVLOG architecture section

### Stage 2: Integration + smoke test
After all agents finish, you (the main session) integrate, fix any cross-cutting issues, and run an end-to-end test with `claude -p`.

### Stage 3: Commit + PR
Single clean commit (or a few logical commits) on a new branch `feat/local-agent-mode` (do NOT pile onto `feat/anthropic-api-support`). Push, open new PR.

---

## Quick reference: how to start the existing proxy

```bash
cd /root/git_farm/cursoride2api
PORT=4141 npm start

# In another terminal:
ANTHROPIC_BASE_URL=http://localhost:4141 claude -p "test" --model claude-opus-4-7

# With debug logging:
DEBUG_LOG=verbose CURSOR_AGENT_DEBUG=1 PORT=4141 npm start
# Logs to ./logs/server-YYYY-MM-DD.log
```

For the new mode you'll add:

```bash
LOCAL_AGENT=1 PORT=4141 npm start
# Same client invocation; should observe ONE /v1/messages POST instead of N+1
```

---

## Open questions for you to resolve

When you start, surface these to the user (or decide for them based on context):

1. **Edit semantics** — Cursor proto has no `editArgs`. opencode's `edit.ts` is 711 lines (most complex tool). For local mode, can we skip `Edit` in v1 and have the model use `Read` + `Write`, OR do we implement a pseudo-edit (read, str-replace, write)?

2. **Permission gates** — match Cursor IDE (no gates) or match Claude Code (per-tool prompts)? My suggestion: v1 = Cursor IDE behavior (no gates) with a `LOCAL_AGENT_ALLOWED_PATHS` env-var-only allowlist. Stronger gates in v2.

3. **Conversation cache** — local mode has only one Anthropic POST per user turn, so the bridge cache becomes simpler. Decide whether to share code with remote-mode or branch.

4. **Streaming** — when client sends `stream: true`, can we stream `textDelta` to Claude Code as Cursor produces it? (Yes, this is desirable; tools execute silently in the stream gaps.)

5. **Failure modes** — if a local tool throws (e.g., `permission denied`), do we forward the error to Cursor as `*Result.error` (so the model can recover) or fail the whole turn?

---

## Sanity check before you start coding

If you've read this far and can answer YES to all of the following, you're ready:

- [ ] I've read `DEVLOG.md` and understand the wire-format details
- [ ] I've looked at `cursor-agent.js` and located `handleExecMessage`
- [ ] I've looked at `/root/git_farm/opencode/packages/opencode/src/tool/` and read at least `read.ts` and `shell.ts`
- [ ] I've looked at `agent_v1.proto` and located the `*Args`/`*Result` message shapes
- [ ] I understand that this is **opt-in via `LOCAL_AGENT=1`** and must not break the existing flow
- [ ] I've decided how to handle Edit (port/pseudo/skip)
- [ ] I have a multi-agent dispatch plan in mind

When you're sure, **dispatch agents A–F in parallel** for Stage 1.

Good luck. The wire format is finicky but the references are solid. The current proxy works — you're adding to it, not rewriting it.
