# Cursor IDE API 端点大全

> 最后更新: 2026-03-20
> 基于 Cursor v2.6.20 逆向分析 + 实际调用验证
> ✅ = 已验证可用 | ⚠️ = 需额外认证/密钥 | ❌ = 已废弃/不可用

---

## 目录

1. [服务器域名](#1-服务器域名)
2. [认证体系](#2-认证体系)
3. [agent.v1 服务 (当前主力)](#3-agentv1-服务-当前主力)
4. [aiserver.v1 服务 (旧版)](#4-aiserverv1-服务-旧版)
5. [其他 RPC 服务](#5-其他-rpc-服务)
6. [REST API 端点](#6-rest-api-端点)
7. [协议规范](#7-协议规范)
8. [可用模型](#8-可用模型)
9. [请求头规范](#9-请求头规范)
10. [凭证提取](#10-凭证提取)
11. [Checksum 算法](#11-checksum-算法)
12. [Exec 消息处理](#12-exec-消息处理)
13. [完整调用示例](#13-完整调用示例)

---

## 1. 服务器域名

### 核心服务器

| 用途 | 域名 | 说明 |
|------|------|------|
| **主 API** ✅ | `api2.cursor.sh` | 所有 RPC 服务的主入口 |
| **分析/遥测** | `api3.cursor.sh` | 遥测数据上报 |
| **备用 API** | `api4.cursor.sh` | 备用入口 |
| **Agent 服务** | `agent.api5.cursor.sh` | Agent 专用入口 |
| **Agent (非隐私)** | `agentn.api5.cursor.sh` | 非 ghost mode |
| **代码仓库** | `repo42.cursor.sh` | 代码索引/搜索 |
| **认证服务** | `prod.authentication.cursor.sh` | Auth0/WorkOS 登录 |

### Agent 地理节点

| 区域 | 域名 |
|------|------|
| 🇺🇸 美西 | `agent-gcpp-uswest.api5.cursor.sh` |
| 🇪🇺 欧洲中部 | `agent-gcpp-eucentral.api5.cursor.sh` |
| 🌏 亚太东南 | `agent-gcpp-apsoutheast.api5.cursor.sh` |

> 💡 **地理节点选择**: IDE 根据用户时区自动选择最近的节点，Agent 请求通过这些节点转发到核心服务器。

---

## 2. 认证体系

### 认证流程

```
用户登录 (Auth0/WorkOS)
    ↓
获取 JWT Token (accessToken + refreshToken)
    ↓
存入本地 state.vscdb (SQLite)
    ↓
每次请求:
  Authorization: Bearer <accessToken>
  x-cursor-checksum: <checksum><machineId>/<macMachineId>
  x-cursor-client-version: 2.6.20
```

### 凭证存储位置

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

### state.vscdb 中的关键键值

| Key | 说明 | 必须 |
|-----|------|------|
| `cursorAuth/accessToken` | JWT 访问令牌 | ✅ 必须 |
| `cursorAuth/refreshToken` | 刷新令牌 | 🔄 续期用 |
| `cursorAuth/openAIKey` | Relay 密钥 (`i7-relay-...`) | - |
| `cursorAuth/cachedEmail` | 登录邮箱 | - |
| `cursorAuth/stripeMembershipType` | 会员类型 (`free`/`pro`/`business`) | - |
| `cursorAuth/stripeSubscriptionStatus` | 订阅状态 (`active`/`canceled`) | - |
| `telemetry.machineId` | 机器 ID (64位hex) | ✅ Checksum |
| `telemetry.macMachineId` | MAC 机器 ID (128位hex) | ✅ Checksum |
| `storage.serviceMachineId` | 服务机器 ID (UUID) | - |

---

## 3. agent.v1 服务 (当前主力)

> 🚀 **这是 Cursor 当前使用的核心 API**，所有对话和代码交互都通过这套服务完成。

### 3.1 AgentService ✅

**基础路径**: `POST https://api2.cursor.sh/agent.v1.AgentService/<Method>`

| 方法 | 类型 | 状态 | 说明 |
|------|------|------|------|
| **`Run`** | BiDi Streaming | ✅ 已验证 | **核心方法** — Agent 对话主入口 |
| **`RunSSE`** | Server Streaming | ⚠️ 需密钥 | SSE 变体，需 `x-idempotent-encryption-key` |
| **`RunPoll`** | Server Streaming | ⚠️ 需密钥 | 轮询变体，配合 RunSSE 使用 |
| **`GetUsableModels`** | Unary | ✅ 已验证 | 获取当前可用模型列表 |
| **`NameAgent`** | Unary | - | 为对话生成标题/名称 |
| **`GetDefaultModelForCli`** | Unary | - | 获取 CLI 默认模型 |
| **`GetAllowedModelIntents`** | Unary | - | 获取模型意图权限 |

#### Run 方法详解

```
端点:  POST /agent.v1.AgentService/Run
类型:  BiDi Streaming (ConnectRPC Envelope)
Content-Type: application/connect+json
```

**请求消息 (`AgentClientMessage`)**:
- `runRequest` — 发起新对话请求
- `execClientMessage` — 回复服务器的 exec 请求
- `clientHeartbeat` — 心跳保活 (每5秒)
- `conversationAction` — 对话操作 (取消/恢复等)
- `kvClientMessage` — KV 存储交互
- `interactionResponse` — 交互响应
- `prewarmRequest` — 预热请求

**响应消息 (`AgentServerMessage`)**:
- `heartbeat` — 服务器心跳
- `execServerMessage` — exec 请求 (要求文件读取/命令执行等)
- `interactionUpdate` — 核心内容流:
  - `textDelta` — 文本增量 ⭐
  - `thinkingDelta` — 思考过程
  - `thinkingCompleted` — 思考完成
  - `tokenDelta` — token 计数增量
  - `turnEnded` — 回合结束 (含 token 用量统计)
  - `stepCompleted` — 步骤完成
- `kvServerMessage` — KV 数据推送

#### GetUsableModels 方法详解

```
端点:  POST /agent.v1.AgentService/GetUsableModels
类型:  Unary (普通 JSON)
Content-Type: application/json
请求:  {}
响应:  { "models": [{ "modelId": "...", "displayName": "...", ... }] }
```

### 3.2 ControlService

**基础路径**: `POST https://api2.cursor.sh/agent.v1.ControlService/<Method>`

| 方法 | 类型 | 说明 |
|------|------|------|
| `Ping` | Unary | 心跳检测/连接验证 |
| `Exec` | Unary | 执行远程命令 |
| `ListDirectory` | Unary | 列出目录内容 |

### 3.3 ExecService

**基础路径**: `POST https://api2.cursor.sh/agent.v1.ExecService/<Method>`

| 方法 | 类型 | 说明 |
|------|------|------|
| `Exec` | Unary | 远程命令执行 |

---

## 4. aiserver.v1 服务 (旧版)

> ⚠️ **大部分已废弃**，新对话已迁移到 agent.v1。部分端点仍可用。

### 4.1 ChatService

**基础路径**: `POST https://api2.cursor.sh/aiserver.v1.ChatService/<Method>`

| 方法 | 类型 | 状态 | 说明 |
|------|------|------|------|
| `StreamUnifiedChat` | Server Streaming | ❌ 已废弃 | 基础流式聊天 |
| `StreamUnifiedChatWithTools` | BiDi Streaming | ❌ Bad Request | 带工具聊天 |
| `StreamUnifiedChatWithToolsSSE` | Server Streaming | ⚠️ 需密钥 | 带工具聊天 SSE |
| `StreamUnifiedChatWithToolsPoll` | Server Streaming | ⚠️ 需密钥 | 带工具聊天轮询 |
| `StreamUnifiedChatWithToolsIdempotent` | BiDi Streaming | ⚠️ 需密钥 | 幂等聊天 |
| `StreamUnifiedChatWithToolsIdempotentSSE` | Server Streaming | ⚠️ 需密钥 | 幂等聊天 SSE |
| `StreamUnifiedChatWithToolsIdempotentPoll` | Server Streaming | ⚠️ 需密钥 | 幂等聊天轮询 |
| `GetConversationSummary` | Unary | - | 获取对话摘要 |
| `StreamSpeculativeSummaries` | Server Streaming | - | 推测性摘要流 |
| `GetPromptDryRun` | Unary | - | Prompt 试运行 (token 估算) |
| `StreamFullFileCmdK` | Server Streaming | - | Cmd+K 全文件流 |
| `ConvertOALToNAL` | Unary | - | 格式转换 (OAL→NAL) |

### 4.2 AiService

**基础路径**: `POST https://api2.cursor.sh/aiserver.v1.AiService/<Method>`

| 方法 | 说明 |
|------|------|
| `StreamingChat` | 基础流式聊天 |
| `Chat` | 非流式聊天 |

---

## 5. 其他 RPC 服务

> 以下服务从 `workbench.desktop.main.js` 逆向提取，按功能分类。

### 5.1 认证与用户

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.AuthService` | `GetFullStripeProfile` | 获取 Stripe 会员档案 |
| `aiserver.v1.AuthService` | `GetUsage` | 获取 API 使用量 |
| `aiserver.v1.AuthService` | `GetSettings` | 获取用户设置 |

### 5.2 后台 Composer

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.BackgroundComposerService` | `StreamBackgroundComposer` | 后台 Composer 流 |
| `aiserver.v1.BackgroundComposerService` | `GetStatus` | 获取后台任务状态 |

### 5.3 代码补全 (Inference)

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.InferenceService` | `StreamingInference` | 代码补全/推理流 |
| `aiserver.v1.InferenceService` | `GetInferenceConfig` | 获取推理配置 |

### 5.4 代码搜索与索引

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.FastSearchService` | `Search` | 快速代码搜索 |
| `aiserver.v1.FastSearchService` | `IndexStatus` | 索引状态 |
| `aiserver.v1.RepositoryService` | `GetRepoInfo` | 获取仓库信息 |
| `aiserver.v1.RepositoryService` | `IndexRepo` | 索引仓库 |

### 5.5 Cmd+K

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.CmdKService` | `StreamCmdK` | Cmd+K 编辑流 |
| `aiserver.v1.CmdKService` | `ApplyEdit` | 应用编辑 |

### 5.6 快速应用

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.FastApplyService` | `Apply` | 快速应用代码更改 |
| `aiserver.v1.FastApplyService` | `StreamApply` | 流式快速应用 |

### 5.7 代码审查

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.ReviewService` | `Review` | 代码审查 |
| `aiserver.v1.BugbotService` | `AnalyzeBug` | Bug 分析 |

### 5.8 对话管理

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.ConversationsService` | `ListConversations` | 列出对话历史 |
| `aiserver.v1.ConversationsService` | `GetConversation` | 获取单个对话 |
| `aiserver.v1.ConversationsService` | `DeleteConversation` | 删除对话 |

### 5.9 BiDi 流管理

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.BidiService` | `CreateSession` | 创建 BiDi 会话 |
| `aiserver.v1.BidiService` | `Poll` | 轮询消息 |

### 5.10 Shadow Workspace

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.ShadowWorkspaceService` | `Create` | 创建影子工作区 |
| `aiserver.v1.ShadowWorkspaceService` | `Status` | 工作区状态 |

### 5.11 MCP 注册

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.MCPRegistryService` | `ListServers` | 列出 MCP 服务器 |
| `aiserver.v1.MCPRegistryService` | `Register` | 注册 MCP 服务器 |

### 5.12 Dashboard

| 服务 | 方法 | 说明 |
|------|------|------|
| `aiserver.v1.DashboardService` | `GetDashboard` | 获取仪表板数据 |

---

## 6. REST API 端点

> 除了 ConnectRPC 外，Cursor 还使用一些传统 REST 端点。

### 认证相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/auth/full_stripe_profile` | 获取 Stripe 会员档案 |
| POST | `/auth/logout` | 登出 |
| POST | `/auth/refresh` | 刷新 Token |
| GET | `/auth/usage` | 获取使用量统计 |

### 配置相关

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/config` | 获取客户端配置 |
| GET | `/config/models` | 获取模型配置 |
| GET | `/feature-flags` | 获取特性标志 |

---

## 7. 协议规范

### ConnectRPC over HTTP/2

所有 RPC 调用基于 **ConnectRPC** 协议，运行在 HTTP/2 上。

#### Unary 调用 (如 GetUsableModels)

```http
POST /agent.v1.AgentService/GetUsableModels HTTP/2
Host: api2.cursor.sh
Content-Type: application/json
Authorization: Bearer <token>
x-cursor-checksum: <checksum>
x-cursor-client-version: 2.6.20

{}
```

响应: 普通 JSON 对象

#### Streaming 调用 (如 Run)

```http
POST /agent.v1.AgentService/Run HTTP/2
Host: api2.cursor.sh
Content-Type: application/connect+json
Connect-Protocol-Version: 1
Authorization: Bearer <token>
x-cursor-checksum: <checksum>
x-cursor-client-version: 2.6.20

<Envelope Frame 1><Envelope Frame 2>...
```

### Envelope 帧格式

```
┌──────────┬──────────────────┬────────────────────────┐
│ Flag(1B) │  Length(4B, BE)  │    JSON Data (NB)      │
└──────────┴──────────────────┴────────────────────────┘
```

| 字段 | 大小 | 说明 |
|------|------|------|
| Flag | 1 byte | `0x00` = 普通帧, `0x02` = 压缩帧 |
| Length | 4 bytes | 大端序 uint32, Data 长度 |
| Data | N bytes | JSON 编码的消息 |

#### 编码 (Node.js)

```javascript
function writeFrame(stream, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const frame = Buffer.alloc(5 + json.length);
  frame[0] = 0;                        // flag
  frame.writeUInt32BE(json.length, 1);  // length
  json.copy(frame, 5);                 // data
  stream.write(frame);
}
```

#### 解码 (Node.js)

```javascript
function parseFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flag = buffer[offset];
    const len = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + len > buffer.length) break;
    const data = buffer.slice(offset, offset + len).toString('utf8');
    messages.push(JSON.parse(data));
    offset += len;
  }
  return { messages, remaining: buffer.slice(offset) };
}
```

---

## 8. 可用模型

> 通过 `GetUsableModels` API 获取 (2026-03-20)，会随 Cursor 版本动态变化。

### Composer 系列 (内置)

| Model ID | 显示名 | 说明 |
|----------|--------|------|
| `default` | Auto | 自动选择最佳模型 |
| `composer-2` | Composer 2 | ⭐ 默认主力模型 |
| `composer-2-fast` | Composer 2 Fast | 快速版 |
| `composer-1.5` | Composer 1.5 | 旧版本 |

### GPT 系列

| Model ID | 显示名 | 级别 |
|----------|--------|------|
| `gpt-5.4-low` | GPT-5.4 Low | 低配 |
| `gpt-5.4-medium` | GPT-5.4 | 标准 |
| `gpt-5.4-medium-fast` | GPT-5.4 Fast | 标准快速 |
| `gpt-5.4-high` | GPT-5.4 High | 高配 |
| `gpt-5.4-high-fast` | GPT-5.4 High Fast | 高配快速 |
| `gpt-5.4-xhigh` | GPT-5.4 Extra High | 超高配 |
| `gpt-5.4-xhigh-fast` | GPT-5.4 Extra High Fast | 超高配快速 |
| `gpt-5.3-codex-spark-preview` | GPT-5.3 Codex Spark | 预览版 |
| `gpt-5.3-codex-low` | GPT-5.3 Codex Low | 低配 |
| `gpt-5.3-codex-low-fast` | GPT-5.3 Codex Low Fast | 低配快速 |
| `gpt-5.3-codex` | GPT-5.3 Codex | ⭐ 标准 |
| `gpt-5.3-codex-fast` | GPT-5.3 Codex Fast | 标准快速 |
| `gpt-5.3-codex-high` | GPT-5.3 Codex High | 高配 |
| `gpt-5.3-codex-high-fast` | GPT-5.3 Codex High Fast | 高配快速 |
| `gpt-5.3-codex-xhigh` | GPT-5.3 Codex Extra High | 超高配 |
| `gpt-5.3-codex-xhigh-fast` | GPT-5.3 Codex Extra High Fast | 超高配快速 |
| `gpt-5.2` | GPT-5.2 | 标准 |
| `gpt-5.2-high` | GPT-5.2 High | 高配 |
| `gpt-5.2-codex-low` ~ `gpt-5.2-codex-xhigh-fast` | GPT-5.2 Codex 系列 | 全级别 |
| `gpt-5.1-low` | GPT-5.1 Low | 低配 |
| `gpt-5.1` | GPT-5.1 | 标准 |
| `gpt-5.1-high` | GPT-5.1 High | 高配 |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini | 迷你 |
| `gpt-5.1-codex-max-high` | GPT-5.1 Codex Max High | 最高配 |

### Claude 系列

| Model ID | 显示名 |
|----------|--------|
| `claude-4.6-sonnet-medium` | Claude 4.6 Sonnet |
| `claude-4.6-sonnet-medium-thinking` | Claude 4.6 Sonnet (思考) |
| `claude-4.6-opus-high` | Claude 4.6 Opus |
| `claude-4.6-opus-high-thinking` | Claude 4.6 Opus (思考) |
| `claude-4.5-opus-high` | Claude 4.5 Opus |
| `claude-4.5-opus-high-thinking` | Claude 4.5 Opus (思考) |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet |
| `claude-4.5-sonnet-thinking` | Claude 4.5 Sonnet (思考) |

### Gemini 系列

| Model ID | 显示名 |
|----------|--------|
| `gemini-3.1-pro` | Gemini 3.1 Pro |
| `gemini-3-pro` | Gemini 3 Pro |
| `gemini-3-flash` | Gemini 3 Flash |

### 其他

| Model ID | 显示名 |
|----------|--------|
| `kimi-k2.5` | Kimi K2.5 |

### 内部模型 (非用户可选)

| Model ID | 用途 |
|----------|------|
| `gpt-5-mini` | Agent 规划 (orientationModel) |
| `gpt-5` | Agent 计划 (planModel) |
| `gpt-5-high` | 后台评分 (judgeModel) |

---

## 9. 请求头规范

### 必需请求头

| Header | 说明 | 示例 |
|--------|------|------|
| `authorization` | Bearer Token 认证 | `Bearer eyJhbG...` |
| `x-cursor-checksum` | 校验和 | `<base64_ts><machineId>/<macMachineId>` |
| `x-cursor-client-version` | 客户端版本 | `2.6.20` |
| `content-type` | 内容类型 | `application/connect+json` (流式) 或 `application/json` (Unary) |
| `connect-protocol-version` | ConnectRPC 版本 | `1` |
| `x-request-id` | 请求 UUID | `550e8400-e29b-41d4-a716-446655440000` |

### 可选请求头

| Header | 说明 | 默认值 |
|--------|------|--------|
| `x-cursor-client-type` | 客户端类型 | `ide` |
| `x-cursor-client-os` | 操作系统 | `windows_nt` / `darwin` / `linux` |
| `x-cursor-client-arch` | CPU 架构 | `x64` / `arm64` |
| `x-cursor-client-device-type` | 设备类型 | `desktop` |
| `x-cursor-client-os-version` | 系统版本 | `10.0.22631` |
| `x-cursor-timezone` | 时区 | `Asia/Shanghai` |
| `x-cursor-config-version` | 配置版本 | - |
| `x-ghost-mode` | 隐私模式 | `false` |
| `x-session-id` | 会话 ID | UUID |
| `x-client-key` | 客户端密钥 (MCP) | AES-GCM JWK |
| `x-amzn-trace-id` | AWS 追踪 | `Root=<uuid>` |
| `x-idempotent-encryption-key` | 幂等加密密钥 | AES-GCM 密钥 |

---

## 10. 凭证提取

### Node.js 提取代码

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

function extractCredentials() {
  const platform = process.platform;
  let dbPath;

  if (platform === 'win32') {
    dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor',
                       'User', 'globalStorage', 'state.vscdb');
  } else if (platform === 'darwin') {
    dbPath = path.join(os.homedir(), 'Library', 'Application Support',
                       'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else {
    dbPath = path.join(os.homedir(), '.config', 'Cursor',
                       'User', 'globalStorage', 'state.vscdb');
  }

  const db = new Database(dbPath, { readonly: true });
  const get = (key) => {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    return row ? row.value : null;
  };

  const creds = {
    accessToken: get('cursorAuth/accessToken'),
    refreshToken: get('cursorAuth/refreshToken'),
    machineId: get('telemetry.machineId'),
    macMachineId: get('telemetry.macMachineId'),
    email: get('cursorAuth/cachedEmail'),
    membership: get('cursorAuth/stripeMembershipType'),
  };

  db.close();
  return creds;
}
```

---

## 11. Checksum 算法

`x-cursor-checksum` 头使用时间混淆 + 机器 ID 组合生成。

### 算法实现

```javascript
function generateChecksum(machineId, macMachineId) {
  // 1. 时间戳编码为 6 字节
  let key = 165;
  const timestamp = Math.floor(Date.now() / 1e6);
  const bytes = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    timestamp & 255,
  ]);

  // 2. XOR 链式混淆
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ key) + (i % 256)) & 0xFF;
    key = bytes[i];
  }

  // 3. Base64 前缀 + 机器 ID 拼接
  const prefix = Buffer.from(bytes).toString('base64');
  return macMachineId
    ? `${prefix}${machineId}/${macMachineId}`
    : `${prefix}${machineId}`;
}
```

### 格式说明

```
x-cursor-checksum: <8字符base64><64位hex_machineId>/<128位hex_macMachineId>
示例: qbNWxw==286b720c4472b286.../1c9cae450e1432567a36...
```

---

## 12. Exec 消息处理

### 服务器可能发送的 Exec 请求

Agent.Run 流中，服务器通过 `execServerMessage` 请求 IDE 执行操作，代理需正确回复。

| exec 类型 | 说明 | 回复类型 | 回复方式 |
|-----------|------|----------|----------|
| `requestContextArgs` | 请求上下文环境 | `requestContextResult` | **必须回复**，提供 OS/shell 信息 |
| `readArgs` | 读取文件内容 | `readResult` | Headless: `fileNotFound` |
| `lsArgs` | 列出目录 | `lsResult` | Headless: `error` |
| `shellArgs` | 执行 Shell 命令 | `shellResult` | Headless: `rejected` |
| `grepArgs` | 搜索文件内容 | `grepResult` | Headless: `error` |
| `writeArgs` | 写入文件 | `writeResult` | Headless: `error` |
| `deleteArgs` | 删除文件 | `deleteResult` | Headless: `error` |
| `diagnosticsArgs` | 获取诊断信息 | `diagnosticsResult` | Headless: 空结果 |
| `recordScreenArgs` | 录屏 | `recordScreenResult` | Headless: `error` |

### Headless 模式通用回复模板

```javascript
function handleExecMessage(execServerMessage, writeFrame, req) {
  const { id, execId } = execServerMessage;
  const base = { id, execId };

  if (execServerMessage.requestContextArgs) {
    // ⚠️ 必须回复! 否则报 "Failed to get request context"
    writeFrame(req, {
      execClientMessage: {
        ...base,
        requestContextResult: {
          success: {
            requestContext: {
              env: { operatingSystem: 'windows', defaultShell: 'powershell' }
            }
          }
        }
      }
    });
  }
  else if (execServerMessage.readArgs) {
    writeFrame(req, { execClientMessage: { ...base, readResult: { fileNotFound: {} } } });
  }
  else if (execServerMessage.lsArgs) {
    writeFrame(req, { execClientMessage: { ...base, lsResult: { error: { path: '', error: 'N/A' } } } });
  }
  else if (execServerMessage.shellArgs) {
    writeFrame(req, { execClientMessage: { ...base, shellResult: { rejected: { reason: 'N/A' } } } });
  }
  else if (execServerMessage.grepArgs) {
    writeFrame(req, { execClientMessage: { ...base, grepResult: { error: 'N/A' } } });
  }
  else if (execServerMessage.writeArgs) {
    writeFrame(req, { execClientMessage: { ...base, writeResult: { error: 'N/A' } } });
  }
  else if (execServerMessage.deleteArgs) {
    writeFrame(req, { execClientMessage: { ...base, deleteResult: { error: 'N/A' } } });
  }
  else if (execServerMessage.diagnosticsArgs) {
    writeFrame(req, { execClientMessage: { ...base, diagnosticsResult: {} } });
  }
}
```

---

## 13. 完整调用示例

### 示例 1: 聊天对话 (AgentService.Run)

```javascript
const http2 = require('http2');
const { v4: uuidv4 } = require('uuid');

async function chat(token, prompt, modelId = 'composer-2') {
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://api2.cursor.sh');
    const checksum = generateChecksum(token.machineId, token.macMachineId);

    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/Run',
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      'authorization': `Bearer ${token.accessToken}`,
      'x-cursor-checksum': checksum,
      'x-cursor-client-version': '2.6.20',
      'x-cursor-timezone': 'Asia/Shanghai',
      'x-request-id': uuidv4(),
    });

    let fullText = '';
    let buffer = Buffer.alloc(0);
    let done = false;

    // 心跳 (每5秒)
    const hb = setInterval(() => {
      try { writeFrame(req, { clientHeartbeat: {} }); } catch {}
    }, 5000);

    function finish() {
      if (done) return; done = true;
      clearInterval(hb);
      try { req.end(); } catch {}
      setTimeout(() => { try { client.close(); } catch {} resolve(fullText); }, 200);
    }

    req.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      // ... parse frames, handle exec, collect textDelta ...
    });

    req.on('end', finish);
    req.on('error', e => { finish(); reject(e); });

    // 发送请求
    writeFrame(req, {
      runRequest: {
        conversationState: {},
        action: {
          userMessageAction: {
            userMessage: { text: prompt }
          }
        },
        modelDetails: { modelId, displayName: modelId, displayNameShort: modelId },
        requestedModel: { modelId },
        conversationId: uuidv4(),
      }
    });
  });
}
```

### 示例 2: 获取模型列表 (GetUsableModels)

```javascript
async function getModels(token) {
  return new Promise((resolve) => {
    const client = http2.connect('https://api2.cursor.sh');
    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/GetUsableModels',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'authorization': `Bearer ${token.accessToken}`,
      'x-cursor-checksum': generateChecksum(token.machineId, token.macMachineId),
      'x-cursor-client-version': '2.6.20',
      'x-request-id': uuidv4(),
    });
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => { client.close(); resolve(JSON.parse(body)); });
    req.write(JSON.stringify({}));
    req.end();
  });
}
```

---

## 附录 A: AgentService.Run 完整流程图

```
Client                              Server (api2.cursor.sh)
  │                                      │
  │──── runRequest ──────────────────────>│  1. 发起请求 (含 prompt + model)
  │                                      │
  │<──── heartbeat ──────────────────────│  2. 服务器心跳
  │<──── execServerMessage ──────────────│  3. requestContextArgs
  │                                      │
  │──── execClientMessage ──────────────>│  4. requestContextResult.success
  │                                      │
  │──── clientHeartbeat ────────────────>│  5. 客户端心跳 (每5秒持续)
  │                                      │
  │<──── kvServerMessage ────────────────│  6. KV 数据 (system/user prompt)
  │<──── kvServerMessage ────────────────│
  │                                      │
  │<──── interactionUpdate ──────────────│  7. thinkingDelta (思考开始)
  │<──── interactionUpdate ──────────────│  8. thinkingCompleted (思考完成)
  │                                      │
  │<──── interactionUpdate ──────────────│  9. textDelta: "Hello" ⭐ 核心内容
  │<──── interactionUpdate ──────────────│     textDelta: " World"
  │<──── interactionUpdate ──────────────│     tokenDelta: { tokens: 3 }
  │<──── interactionUpdate ──────────────│     stepCompleted
  │                                      │
  │<──── interactionUpdate ──────────────│ 10. turnEnded (含 token 统计)
  │                                      │     { inputTokens, outputTokens,
  │                                      │       cacheReadTokens, cacheWriteTokens }
  │                                      │
  │──── req.end() ──────────────────────>│ 11. 关闭连接
```

## 附录 B: 变量名映射表

> 逆向分析中 minified 变量名与 protobuf 类型的对应关系

| minified | Protobuf 类型 |
|----------|---------------|
| `VNe` | `agent.v1.AgentClientMessage` |
| `jte` | `agent.v1.AgentServerMessage` |
| `yKl` | `agent.v1.AgentRunRequest` |
| `rye` | `agent.v1.ConversationAction` |
| `qha` | `agent.v1.UserMessageAction` |
| `m$e` | `agent.v1.UserMessage` |
| `jCt` | `agent.v1.RequestContext` |
| `rEe` | `agent.v1.ConversationStateStructure` |
| `Qfi` | `agent.v1.ModelDetails` |
| `Kdn` | `agent.v1.RequestedModel` |
| `sKl` | `agent.v1.RequestContextResult` |
| `oKl` | `agent.v1.RequestContextSuccess` |
| `g$e` | `agent.v1.ExecClientMessage` |
| `zou` | `agent.v1.ClientHeartbeat` |
| `OFc` | `aiserver.v1.StreamUnifiedChatRequestWithTools` |
| `ORe` | `aiserver.v1.StreamUnifiedChatRequest` |
| `G9e` | `aiserver.v1.StreamUnifiedChatResponseWithTools` |
| `C8n` | `aiserver.v1.StreamUnifiedChatResponse` |
| `Qw` | `aiserver.v1.ConversationMessage` |
| `Yf` | `aiserver.v1.ModelDetails` |
| `Eye` | `aiserver.v1.BidiRequestId` |
| `X$e` | `aiserver.v1.BidiPollRequest` |
| `eqe` | `aiserver.v1.BidiPollResponse` |
| `rRu` | `agent.v1.AgentService` (服务定义) |
| `WAi` | `aiserver.v1.ChatService` (服务定义) |
| `rau` | Agent Connect Client (运行时) |

---

## 附录 C: 重要注意事项

### ⚠️ 关键限制

1. **BiDi 流不能提前关闭** — 发送 `runRequest` 后必须保持流开放直到 `turnEnded`
2. **必须回复 requestContextArgs** — 不回复会导致 "Failed to get request context" 错误
3. **心跳必须持续发送** — 建议每 5 秒一次 `clientHeartbeat`
4. **模型名必须精确匹配** — 使用不存在的模型名会返回 "Model name is not valid"
5. **版本号要足够新** — `x-cursor-client-version` 太低可能被拒绝
6. **HTTP/2 是必须的** — 不支持 HTTP/1.1

### 🔒 加密相关

- `x-idempotent-encryption-key`: SSE/Poll 端点需要 AES-GCM 256位密钥
- `mcpEncryptionKey`: MCP 加密密钥，存储在 `_secretStorageService` 中
- 密钥通过 `crypto.subtle.generateKey('AES-GCM', 256)` 生成

### 📝 KV Blob 数据

- AI 完整回复（含思考过程）存储在 KV `setBlobArgs` 中
- Blob 数据为 Base64 编码的 JSON
- 包含 system/user/assistant 全角色消息
- assistant 消息中含 `<think>...</think>` 思考过程

---

> **免责声明**: 本文档仅用于学习研究目的。使用 API 时请遵守 Cursor 的服务条款。
