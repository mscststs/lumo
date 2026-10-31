# 协议契约（L0 probe + L1 MCP over Port）

本文是 wire 级参考。两个仓库的 `protocol.ts` 必须逐字一致（除注释与提供方额外的
`isProbeRequest`）。任何一侧新增字段，另一侧都必须**向后兼容**。

## 1. 常量

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `PROBE_CHANNEL` | `lumo:probe` | L0 请求的固定 `channel` |
| `PROBE_VERSION` | `1` | L0 版本，整数 |
| `MCP_PORT_NAME` | `lumo:mcp` | L1 Port 名，大小写敏感 |
| 扩展 ID | `/^[a-p]{32}$/` | Chromium 扩展 ID 字符集与长度 |

宿主：`lib/mcp/extension-protocol.ts`；提供方：`lib/agent/protocol.ts`。

## 2. L0 — probe

### 2.1 传输

```
chrome.runtime.sendMessage(providerExtensionId, probeRequest)
```

- 只能从**扩展上下文**（side panel / options / background）发起，不能从 content script 发起。
- 提供方必须用 `chrome.runtime.onMessageExternal` 接收。
- 提供方若未声明 `externally_connectable`，调用会以
  `Could not establish connection. Receiving end does not exist.` 拒绝——
  宿主把它翻译成「未安装 / 未暴露端点」，而非让用户处理异常。

### 2.2 请求

```ts
interface ProbeRequest {
  channel: 'lumo:probe';
  version: number;              // 当前为 1
  id?: string;                  // 诊断用请求 id（宿主传 randomUUID）
  client?: { id: string; name: string; version: string }; // 宿主自报身份
}
```

`client` 是**展示提示**，不是身份。提供方的授权判断只能使用
`chrome.runtime.MessageSender.id`。

### 2.3 响应

```ts
interface ProbeResponse {
  ok: boolean;                  // 协议层是否成功，不是「是否授权」
  service?: { namespace: string; name: string; version: string };
  status?: {
    enabled: boolean;           // 提供方的总开关
    authorized: boolean;        // 调用方是否在 allowlist
    ready: boolean;             // 目标能力（chrome.userScripts 等）是否可用
    pendingApproval?: boolean;  // 已记录请求，等待用户审批
    reason?: { code: string; message: string }; // ready=false 的人话原因
  };
  error?: { code: string; message: string };     // ok=false 时
}
```

语义约束：

| 字段 | 规则 |
| --- | --- |
| `ok` | 只有**协议**失败才为 `false`（版本不支持、内部异常）。业务拒绝一律 `ok:true` + `status` |
| `service` | 版本不匹配时也应返回，让宿主能显示「这是谁」 |
| `status.enabled` | 用户总开关；`false` 时不读任何业务数据 |
| `status.authorized` | `sender.id ∈ allowlist`；**不要**因为 `client.id` 相同就放行 |
| `status.ready` | 与能力相关（如 `chrome.userScripts` 可用性）；`false` 必须给 `reason.message` |
| `pendingApproval` | 仅在「未授权 + 已记录待审批 + 用户未 dismiss」时为 `true` |
| `error.code` | 提供方当前只用 `UNSUPPORTED_PROTOCOL` / `INTERNAL` |

### 2.4 提供方判定顺序（必须照此实现）

1. `isProbeRequest(message)` 不通过 → 返回 `false`（不占用通道，不回复）。
2. `request.version !== PROBE_VERSION` → `{ ok:false, service, error:{code:'UNSUPPORTED_PROTOCOL'} }`。
   版本检查在策略检查**之前**：旧宿主不应因为未授权而看到「请授权」。
3. 读取 `agentSettings`，由 `sender.id` 计算 `authorized`。
4. 计算 `ready`（如 `checkUserScriptsAvailable()`）。
5. 未授权 → `recordPendingRequest(senderId, request.client)`，必要时 `promptForRequest()`。
6. 返回 `ok:true` + `service` + `status`（含 `pendingApproval` / `reason`）。

`handleProbe` 必须吞掉自身异常（审批记录、提示打开设置都可能失败），
只有外层 `onMessageExternal` 的兜底才回 `INTERNAL`。

### 2.5 宿主判定顺序

`probeExtension()`（`lib/mcp/extension-probe.ts`）：

1. 组请求；`client.id = chrome.runtime.id`，`client.version = manifest.version`。
2. `Promise.race` 式 1500ms 超时（`PROBE_TIMEOUT_MS`）。
3. `isProbeResponse()` 守卫：非对象 / `ok` 非布尔 → 「malformed probe response」。
4. 捕获异常并分类：消息匹配
   `/Receiving end does not exist|Could not establish connection/i` → `unreachable: true`。

`ExtensionMcpServer.doConnect()` 的判定顺序见 SKILL.md §5。

### 2.6 时序

```
host                          provider
 │  sendMessage(lumo:probe)      │
 │─────────────────────────────>│  version → policy → ready
 │                              │  (未授权：记录 pending，可能打开设置页)
 │<─────────────────────────────│  { ok, service, status }
 │  status 全部通过              │
 │  connect(extId, lumo:mcp)    │
 │─────────────────────────────>│  onConnectExternal
 │                              │  resolveAgentAccess(sender.id)
 │                              │  ├─ 拒绝 → transport.close()
 │                              │  └─ 通过 → new McpServer(...).connect(transport)
 │  initialize (JSON-RPC)       │
 │─────────────────────────────>│
 │<─────────────────────────────│
 │  tools/list                  │
 │<─────────────────────────────│
 │  tools/call ...              │
```

## 3. L1 — MCP over `chrome.runtime.Port`

### 3.1 帧格式

**裸 JSON-RPC 对象**，没有信封、没有 base64、没有额外字段：

```ts
port.postMessage(jsonRpcMessage);   // 发送
port.onMessage.addListener(fn);     // 接收
```

不要包成 `{type:'mcp', payload}`——那会破坏 SDK 的 `JSONRPCMessage` 类型与错误处理。

### 3.2 双方职责

| | 宿主（client） | 提供方（server） |
| --- | --- | --- |
| SDK | `@ai-sdk/mcp` `createMCPClient` | `@modelcontextprotocol/sdk` `McpServer` |
| Transport 接口 | `MCPTransport`（含 `protocolVersion?` / `setProtocolVersion?`） | SDK `Transport`（无版本字段） |
| 会话 | 一个 `ExtensionMcpServer` 一个逻辑会话 | **每个 Port 新建一个 `McpServer`** |
| 协商 | SDK 发起 `initialize` | SDK 应答 |
| 工具 | `listTools()` → 包装成 AI SDK tool | `registerTool()` |

两个 SDK 必须保持 MCP spec 兼容。升级任一侧时，必须用真实客户端跑一次
`initialize / tools/list / tools/call`（见 `references/development.md`）。

### 3.3 缓冲（两侧都要）

客户端 `createMCPClient` 的调用顺序是「先挂 `onmessage`，再 `start()`」，
服务端在授权检查期间也不能丢消息。所以两侧 transport 都实现：

```ts
private active = false;
private pending: JSONRPCMessage[] = [];

private handleMessage = (message: unknown) => {
  if (this.closed) return;
  if (!this.active) { this.pending.push(message as JSONRPCMessage); return; }
  this.onmessage?.(message as JSONRPCMessage);
};

async start() {
  this.active = true;
  const queued = this.pending;
  this.pending = [];
  for (const m of queued) this.onmessage?.(m);
}
```

没有这段缓冲，`initialize` 响应可能在客户端完成注册前到达，表现为「连接成功但没有工具」。

### 3.4 `onclose` 的归属（宿主侧陷阱）

`createMCPClient()` 会**覆盖** `transport.onclose`（指向它自己的 `onClose`）。
所以：

```ts
const transport = ChromePortTransport.connect(id);
transport.onclose = () => { this.needsReconnect = true; };  // 会被覆盖
const client = await createMCPClient({ transport, ... });

const sdkOnClose = transport.onclose;                        // 链式保留
transport.onclose = () => { sdkOnClose?.(); this.needsReconnect = true; };
```

`ChromePortTransport` 因此额外暴露 `onDisconnect?`（语义是「物理端口断开」），
但当前实现仍以 `transport.isClosed` 作为存活判据：`ensureConnected()` 在
`needsReconnect || transport.isClosed` 时重连。**改这里必须保留三层判据**，
否则会出现「客户端以为还连着、工具调用直接失败」。

### 3.5 关闭语义

| 事件 | 含义 | 宿主反应 | 提供方反应 |
| --- | --- | --- | --- |
| `port.disconnect()`（主动） | 正常关闭 | `disconnect()`：清空工具缓存 | `onclose` → `server.close()` |
| 提供方 SW 空闲回收 | 物理断开，服务仍在 | 标记 `needsReconnect`，**保留**缓存工具 | 无（进程已回收） |
| 提供方被卸载/禁用 | 逻辑消失 | 下次调用 `probe` 失败 → `error` | — |
| 宿主关掉开关 | 用户意图 | `disconnect()` + 清空 | Port 收到断开 |

因此 `disconnect()` 与「端口掉了」是两种不同处理：
前者清空工具，后者必须保留（否则模型会在重连窗口里失去工具定义）。

### 3.6 重连为什么必须重新 `initialize`

提供方 `onConnectExternal` 对每个 Port 执行 `createAgentMcpServer(...)` 并 `connect(transport)`，
即**新会话、新 server 实例**。`initialInitializeResult` 只适用于「服务端会保留会话」的传输
（如 Streamable HTTP），在这里复用会拿到一个服务端不认识的 session。

重连流程（`ensureConnected()`）：

```
缓存工具保留
  → connect()
      → probe（校验策略仍允许）
      → 新 Port + 新 client + 新 initialize
      → tools/list 覆盖缓存
  → 执行原 tool call（用缓存的 local name）
```

### 3.7 多上下文与并发

宿主会在 **background / side panel / options** 各自初始化一次 registry，
因此同一个提供方可能同时看到 **多条 Port / 多个 MCP 会话**。

提供方必须保证：

- 每 Port 一个 `McpServer`，不共享 session 级状态；
- 模块级状态（限流桶、审计队列）可被多会话并发访问，仍需按 `sender.id` 聚合；
- 任何会话都不能因为另一个会话关闭而失效（不要在 `onclose` 里做全局清理）。

## 4. 版本演进

| 变更 | 做法 |
| --- | --- |
| 新增可选请求/响应字段 | 不改 `PROBE_VERSION`；双方守卫必须容忍未知字段 |
| 改变字段语义、删除字段、改变判定顺序 | `PROBE_VERSION + 1`；提供方回 `UNSUPPORTED_PROTOCOL` 并附 `service` |
| 新增 MCP 能力（resources 等） | 走 MCP 标准能力协商，不动 L0 |
| 拆分/重命名工具 | 提供方改名即视为新工具；宿主 `MAX_TOOLS` 与命名空间规则不变 |

宿主对 probe 响应只做 `isProbeResponse()`（`ok` 为布尔）这一层守卫，
不做 schema 全量校验——新增字段因此天然兼容；但**不要**依赖未校验字段做安全判断。
