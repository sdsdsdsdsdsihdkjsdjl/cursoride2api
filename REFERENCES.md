# Cursor reverse-engineering references

Consolidated catalog of every external Cursor RE material we've consulted, adopted, cited, or deliberately skipped. Lives in the repo so the next person picking up this project doesn't have to reconstruct the landscape.

The shorter per-purpose pointers in `README.md` (user-facing) and `DEVLOG.md` (engineering notes) link here for the full picture. `HANDOVER_LOCAL_MODE.md` lists the subset cloned locally for hands-on inspection.

---

## What we actually consumed from

These directly informed the code in this repo.

| Repo | What we took | Where it lives in our code |
|---|---|---|
| [`ephraimduncan/opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor) | Vendored compiled protobuf schemas; reference TypeScript proxy showing the agent loop + exec dispatch | `src/proto/agent_pb.mjs` (3250 lines, vendored verbatim); patterns mirrored across `src/cursor-agent.js` |
| [`burpheart/cursor-tap`](https://github.com/burpheart/cursor-tap) | Packet-capture-based RE; the authoritative `agent_v1.proto` (4345 lines) used to cross-check our hand-curated subset | Read-only reference; not vendored. Helped resolve `interactionQuery`, `webFetchRequestQuery`, and other wire shapes |
| [`anyrobert/cursor-api-proxy`](https://github.com/anyrobert/cursor-api-proxy) | Health-aware token rotation design (`account-pool.ts`) | Ported into `TokenPool` class in `server.js` (active-request tracking, 429 parking, LRU tie-break) |
| [`JiuZ-Chn/Cursor-To-OpenAI`](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) | Backend-direct architecture pattern; dated-variant fallback regex; fuller IDE-style header survey | Influenced the `claude-{opus,sonnet}-4-7-YYYYMMDD` fallback in `mapAnthropicModel`; informed the header set in `buildHeaders` |
| [`caozhiyuan/copilot-api`](https://github.com/caozhiyuan/copilot-api) | Compaction / subagent marker detection logic | Ported into `src/preprocess.ts` (`detectCompactType`, `detectSubagentMarker`) |
| [`unkn0wncode/extract-cursor-protos`](https://github.com/unkn0wncode/extract-cursor-protos) | Full `aiserver.v1` + `agent.v1` proto registry (~23k lines, ~64 services, ~792 RPCs) extracted from Cursor's bundle | Used to inform the (reverted) ChatService migration — see DEVLOG section on that attempt |
| [`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es) | Protobuf-ES runtime library (not Cursor RE, but the protocol substrate) | `@bufbuild/protobuf` in `package.json` |

## Cross-checked but did not adopt

These we read carefully, learned from, and either deliberately rejected or deemed not applicable. Useful as decision history — the rationale for *not* taking something is sometimes more durable than the *yes* picks.

| Repo | What it offers | Why we didn't adopt |
|---|---|---|
| [`JJDTrump/cursor-reverse-engineering`](https://github.com/JJDTrump/cursor-reverse-engineering) | Cursor IDE v3.2.11 deep RE (Chinese). Single-README covering gRPC services, headers, ModelDetails, `x-cursor-checksum` algorithm. | Several claims are stale vs. the current `agent.v1.AgentService` we target. The documented "HMAC" checksum is plausibly wrong — our XOR-feedback `generateChecksum()` matches what every working open-source proxy uses. Worth scanning, but treat dated material with skepticism. |
| [`yokingma/OpenCursor`](https://github.com/yokingma/OpenCursor) | Small TS proxy. Documents `WorkosCursorSessionToken` cookie sourcing. | Mostly redundant with `JiuZ-Chn/Cursor-To-OpenAI` which is more polished. Their `genChecksum` has a documented bug (incorrect byte ordering). |
| [`leeguooooo/agent-cli-to-api`](https://github.com/leeguooooo/agent-cli-to-api) | Multi-CLI gateway (cursor-agent / codex / claude / gemini). | CLI-wrapping architecture (we hit the backend directly). Different surface entirely. |
| [`Azhi-ss/cursorcli2api`](https://github.com/Azhi-ss/cursorcli2api), [`tageecc/cursor-agent-api-proxy`](https://github.com/tageecc/cursor-agent-api-proxy) | Smaller CLI-wrapping experiments. | CLI-wrapping, different concern. |
| [`liuw1535/cursor-to-openai-nexus`](https://github.com/liuw1535/cursor-to-openai-nexus) | Backend-direct proxy (web-API style). | Older / less polished than `JiuZ-Chn`. |
| [`vibe-coding-labs/cursor-reverse-engineering`](https://github.com/vibe-coding-labs/cursor-reverse-engineering) | Older reverse work (Cursor 0.48.8). | Predates the connect+proto migration; not authoritative for current Cursor versions. |
| [`zxc1314521/cursor-unpacked`](https://github.com/zxc1314521/cursor-unpacked) | Dumps unpacked `app.asar` resources. | Bulk dump — useful only for ad-hoc grepping, no analysis. |

## Local working copies in `/tmp` (not committed)

These were cloned for hands-on inspection. Not part of the repo — if you start fresh on a new machine, re-clone the ones you need.

| Path | Source |
|---|---|
| `/tmp/cursor-tap` | `burpheart/cursor-tap` |
| `/tmp/extract-cursor-protos` | `unkn0wncode/extract-cursor-protos` |
| `/tmp/opencode-cursor` | `ephraimduncan/opencode-cursor` |
| `/tmp/opencode-cursor-eph` | local variant of `opencode-cursor` |
| `/tmp/cursor-to-openai` | `JiuZ-Chn/Cursor-To-OpenAI` |
| `/tmp/opencursor` | `yokingma/OpenCursor` |
| `/tmp/jjdtrump-cursor-re` | `JJDTrump/cursor-reverse-engineering` |
| `/tmp/cursor-grpc` | community gRPC `.proto` files extracted from Cursor's minified bundle |
| `/tmp/cursor_api_demo` | small ad-hoc cursor-api experiment |
| `/tmp/Antigravity-cursor-proxy` | proxy targeting Antigravity (a Cursor variant) |

## Broader catalog (from the upstream Cursor RE survey)

The original survey doc — `~/Dropbox/cursor_cursor_cli_reverse_engineering_r.md` — catalogs 29 repos across five categories. The lists below capture the survey's full breadth so we don't lose track of the landscape; most we deliberately don't touch because they target adjacent concerns (anti-abuse bypass, prompt extraction) rather than the API/protocol layer.

### Direct binary / protocol RE

- [`JJDTrump/cursor-reverse-engineering`](https://github.com/JJDTrump/cursor-reverse-engineering) — (see above)
- [`vibe-coding-labs/cursor-reverse-engineering`](https://github.com/vibe-coding-labs/cursor-reverse-engineering) — (see above)
- [`unkn0wncode/extract-cursor-protos`](https://github.com/unkn0wncode/extract-cursor-protos) — (see above)
- [`zxc1314521/cursor-unpacked`](https://github.com/zxc1314521/cursor-unpacked) — (see above)

### CLI → OpenAI/Anthropic proxies (cursor-agent wrappers)

- [`anyrobert/cursor-api-proxy`](https://github.com/anyrobert/cursor-api-proxy) — (see above)
- [`leeguooooo/agent-cli-to-api`](https://github.com/leeguooooo/agent-cli-to-api) — (see above)
- [`Azhi-ss/cursorcli2api`](https://github.com/Azhi-ss/cursorcli2api) — (see above)
- [`tageecc/cursor-agent-api-proxy`](https://github.com/tageecc/cursor-agent-api-proxy) — (see above)
- [`gg2chiu/cursor-cli-proxy`](https://github.com/gg2chiu/cursor-cli-proxy)
- [`mamercad/cursor-cosplay`](https://github.com/mamercad/cursor-cosplay)
- [`kilhyeonjun/cursor-agent-gateway`](https://github.com/kilhyeonjun/cursor-agent-gateway)
- [`andeya/cursor-brain`](https://github.com/andeya/cursor-brain)
- [`tak633b/cli-bridge`](https://github.com/tak633b/cli-bridge)

### Web / HTTP API RE (backend-direct, our architecture)

- [`JiuZ-Chn/Cursor-To-OpenAI`](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) — (see above)
- [`liuw1535/cursor-to-openai-nexus`](https://github.com/liuw1535/cursor-to-openai-nexus) — (see above)
- [`yokingma/OpenCursor`](https://github.com/yokingma/OpenCursor) — (see above)
- [`ephraimduncan/opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor) — (see above)
- [`burpheart/cursor-tap`](https://github.com/burpheart/cursor-tap) — (see above)

### Machine-ID / device-fingerprint bypass (adjacent territory, we don't touch)

Anti-abuse RE rather than API RE. Useful if you're studying how Cursor identifies clients, but not what this proxy does.

- [`yuaotian/go-cursor-help`](https://github.com/yuaotian/go-cursor-help) — 26.3k ⭐, the largest in this space
- [`agentcodee/cursor-free-everyday`](https://github.com/agentcodee/cursor-free-everyday) — 6.1k ⭐
- [`kingparks/cursor-vip`](https://github.com/kingparks/cursor-vip) — 4.8k ⭐, account-sharing model
- [`liqiang-xxfy/fly-cursor-free`](https://github.com/liqiang-xxfy/fly-cursor-free) — 1.8k ⭐
- [`ultrasev/cursor-reset`](https://github.com/ultrasev/cursor-reset) — 1.5k ⭐
- [`isboyjc/cursor-reset`](https://github.com/isboyjc/cursor-reset) — 1.2k ⭐
- [`hamflx/cursor-reset`](https://github.com/hamflx/cursor-reset) — 962 ⭐
- [`vibe-coding-labs/JG-Cursor-cracker`](https://github.com/vibe-coding-labs/JG-Cursor-cracker) — 78 ⭐

### Prompt / jailbreak / extracted system prompts (adjacent, we don't touch)

- [`x1xhlol/system-prompts-and-models-of-ai-tools`](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) — 136k ⭐, includes Cursor's system prompts among many others
- [`labac-dev/cursor-system-prompts`](https://github.com/labac-dev/cursor-system-prompts) — 50 ⭐
- [`rsproule/cursor-prompts`](https://github.com/rsproule/cursor-prompts) — 28 ⭐
- [`alexander-morris/cursor-jailbreak`](https://github.com/alexander-morris/cursor-jailbreak) — 44 ⭐

## Protocol / library references

- [Connect protocol spec](https://connectrpc.com/docs/protocol) — frame format, end-stream trailers. We speak `application/connect+proto`.
- [`@bufbuild/protobuf` docs](https://github.com/bufbuild/protobuf-es) — protobuf runtime.

## Local RE docs in this repo

- `Cursor IDE API 逆向工程文档.md` — older Chinese RE notes (predates the connect+proto migration, still useful for non-tool flows).
- `Cursor API 端点大全.md` — Chinese endpoints catalog.

## Original survey

- `~/Dropbox/cursor_cursor_cli_reverse_engineering_r.md` — the survey doc that catalogues the broader 29-repo landscape. Not in the repo (lives in the original author's Dropbox).

---

**Maintenance note.** When a new repo becomes relevant, add it to the appropriate section above with a one-line description and one-line rationale for inclusion (or skip). Cross-link from `README.md` / `DEVLOG.md` when it informs a specific design decision.
