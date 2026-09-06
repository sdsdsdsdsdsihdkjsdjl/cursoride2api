# Changelog - 2026-06-25

Branch: `feat/anthropic-api-support`
Source branch reviewed: `feat/ratlc-mvp` / `cursoride2api_ratlc`
Primary port commit: `e642210 fix: port Claude Code compatibility hardening`

## Claude Code Compatibility Hardening Port

This entry documents the reusable compatibility work ported back from the RATLC branch into the core `cursoride2api` branch. RATLC-specific pool/runtime/dashboard behavior was intentionally left out; only shared Claude Code / Cursor Agent protocol building blocks were brought back.

### Ported

- Added Cursor exec stream close handling after exec results to prevent Cursor from leaving tool streams open and stalling later tool calls.
- Added forward-compatible handling for newer Cursor exec protobuf fields:
  - field `27`: `execute_hook_args`
  - field `28`: `subagent_args`
- Added safe Cursor-native subagent to Claude Code `Task` passthrough:
  - normalizes `subagent_type` to client-safe values, defaulting to `general-purpose`
  - forwards only valid Claude Code Task model keywords (`sonnet`, `opus`, `haiku`) unless overridden by env
  - supports operator overrides such as `CURSOR_SUBAGENT_TYPE_MAP` and `CURSOR_SUBAGENT_MODEL_KEYWORDS`
- Added proxy-local thinking block support:
  - new `src/proxy-thinking-adapter.js`
  - emits proxy-local signatures with `proxy-local-thinking-v1.*`
  - strips proxy-local thinking blocks from future prompts so unsigned UI-only thinking is not replayed as model context
  - keeps `CURSOR_REINJECT_THINKING=1` as the separate opt-in proxy-side prompt reinjection path
- Added tool-name and hallucinated-tool compatibility improvements:
  - unwraps `mcp_` wire aliases such as `mcp_Glob` -> `Glob`
  - recognizes both `[Tool call: ...]` and `[Tool call] ...` textual patterns
  - maps `StrReplace` -> `Edit`
  - normalizes common `Edit` and `Grep` argument variants
- Added default client web-tool filtering policy:
  - client-declared broad WebSearch/Search is filtered by default so broad search stays on Cursor native web search
  - client WebFetch/Fetch remains available by default unless `CURSOR_SERVER_WEBFETCH=0`
- Added tool-routing prompt notes so the model understands API-client tools are available through the bridge and should not be treated as missing Cursor IDE config.
- Added Anthropic image block forwarding into Cursor selected context for latest-user base64 images.
- Wired documented stall timeout env overrides:
  - `CURSOR_STALL_TIMEOUT_MS`
  - `CURSOR_STALL_TIMEOUT_MS_WITH_CONTENT`
- Added `x-api-key` request auth compatibility alongside `Authorization: Bearer ...`.
- Added focused tests under `tests/src/` and an `npm test` script.

### Not Ported

- RATLC pool/scaffolding runtime.
- RATLC dashboard/public UI.
- RATLC launch/pool manager configuration.
- Virtual `agent-tools` store and local tool adapter runtime.
- RATLC-specific branch behavior that would change the core branch's purpose.

### Validation

Ran and passed:

```bash
npm test
node --check server.js
node --check src/anthropic-tools.js
node --check src/anthropic-converter.js
node --check src/cursor-agent.js
node --check src/streaming-hallucination-filter.js
node --check src/thinking-history.js
node --check src/stall-thresholds.js
node --check src/proxy-thinking-adapter.js
git diff --check
```
