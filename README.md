# ACP Session Manager

OpenClaw Plugin，通过 Tools + Service + Hooks 实现完整的 ACP 会话管理。

## 功能

- **拉起 ACP 会话** — 支持 Codex、Claude、Gemini 等多种 Agent
- **会话生命周期管理** — 列出、查询状态、关闭
- **Session 介入** — 追加消息、取消、修改配置
- **审批透出** — 子 Session 审批请求自动注入主 Session，主 Agent 决策后回传

## 工具列表

| 工具 | 说明 |
|------|------|
| `acp_launch` | 拉起一个新的 ACP 会话 |
| `acp_list` | 列出所有管理的 ACP 会话 |
| `acp_send` | 向指定会话发送消息（介入） |
| `acp_cancel` | 取消正在执行的会话 |
| `acp_config` | 修改会话配置（model/mode） |
| `acp_close` | 关闭并清理会话 |
| `acp_approve` | 响应审批请求 |

## 架构

```
主 Session Agent
    ↕ Tools
ACP Session Manager Plugin
    ├── Service Layer (会话池、状态管理)
    ├── Hooks Layer (审批捕获、事件注入)
    └── AcpRuntime (内嵌 ACPX 后端)
```

## 构建 & 打包

```bash
# 安装依赖
pnpm install

# 构建（TypeScript → dist/）
pnpm build

# 开发模式（watch）
pnpm dev

# 打包为 tgz
npm pack
# 产出: ac-acp-session-manager-<version>.tgz
```

## 安装到 OpenClaw

### 方式一：从 tgz 安装

```bash
openclaw plugin install ./ac-acp-session-manager-0.3.0.tgz
```

### 方式二：从 npm registry 安装

```bash
openclaw plugin install @ac/acp-session-manager
```

### 方式三：本地开发模式

在 OpenClaw 的插件配置文件（通常为 `~/.openclaw/plugins.json` 或工作区 `.openclaw/plugins.json`）中手动添加：

```json
{
  "plugins": [
    {
      "id": "acp-session-manager",
      "path": "/path/to/acp-session-manager"
    }
  ]
}
```

> 要求 OpenClaw 版本 >= 2026.5.28

## 在 OpenClaw 中配置

### 工具注册（openclaw.json）

在工作区或全局的 `openclaw.json` 中，需将 ACP 工具注册到主 Agent 的 `tools` 配置中，使其对主 Agent 可见：

```json
{
  "tools": {
    "profile": "full",
    "allow": [
      "group:plugins",
      "acp_launch",
      "acp_list",
      "acp_send",
      "acp_cancel",
      "acp_config",
      "acp_close",
      "acp_approve",
      "exec",
      "read",
      "write",
      "edit",
      "web_search",
      "web_fetch",
      "image",
      "process",
      "cron",
      "subagents",
      "update_plan"
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `profile` | 工具集基线：`"full"` 包含所有内置工具，`"minimal"` 仅核心工具 |
| `allow` | 在 profile 基础上额外启用的工具列表。`"group:plugins"` 启用所有已安装插件暴露的工具；也可逐个列出 `acp_*` 工具精确控制 |

> 如果只使用 `"group:plugins"`，所有插件注册的工具会自动可用，无需逐个列出 `acp_*`。显式列出可在不启用 `group:plugins` 时精确授权。

### 插件参数配置

插件安装后默认启用，可在 OpenClaw 设置中调整参数：

```json
{
  "acp-session-manager": {
    "maxSessions": 50,
    "sessionTtlHours": 24,
    "approvalTimeoutMs": 300000,
    "cwd": "/your/workspace",
    "stateDir": "/your/workspace/.acp-sessions",
    "permissionMode": "approve-reads",
    "agents": {
      "qoder": "qodercli --acp",
      "claude": "npx -y @agentclientprotocol/claude-agent-acp@latest",
      "my-custom-agent": "my-agent-bin --acp"
    }
  }
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxSessions` | number | 50 | 最大并发会话数 |
| `sessionTtlHours` | number | 24 | 会话 TTL（小时），超时自动清理 |
| `approvalTimeoutMs` | number | 300000 | 审批请求超时时间（毫秒） |
| `cwd` | string | 工作区目录 | ACP 会话工作目录 |
| `stateDir` | string | `{cwd}/.acp-sessions` | 会话状态持久化目录 |
| `permissionMode` | string | `"approve-reads"` | 权限策略：`approve-all` / `approve-reads` / `deny-all` |
| `agents` | object | 见内置列表 | 自定义 Agent 启动命令，key 为 agent 名称，value 为 shell 命令 |

### 内置 Agent 列表

| Agent ID | 命令 |
|----------|------|
| `qoder` | `qodercli --acp` |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| `codex` | `npx -y @agentclientprotocol/codex-acp@latest` |
| `gemini` | `gemini --acp` |
| `opencode` | `npx -y opencode-ai acp` |
| `kimi` | `kimi acp` |
| `qwen` | `qwen --acp` |
| `cursor` | `cursor-agent acp` |
| `copilot` | `copilot --acp --stdio` |
| `kilocode` | `npx -y @kilocode/cli acp` |
| `trae` | `traecli acp serve` |
| `openclaw` | `openclaw acp` |

通过 `agents` 配置项可覆盖内置命令或注册新的 Agent。

### 工具权限控制（Tool Profile / Allows）

插件通过 `permissionMode` 和 `permissionPolicy` 两级机制控制子 Agent 的工具调用权限。

#### permissionMode（权限模式）

全局策略，决定子 Agent 工具调用的默认审批行为：

| 模式 | 行为 |
|------|------|
| `approve-reads` | 自动放行读/搜索类操作，写/执行类需审批（**默认**） |
| `approve-all` | 所有操作自动放行，无需审批 |
| `deny-all` | 所有操作均需主 Agent 审批后才执行 |

#### permissionPolicy（细粒度权限策略）

在 `permissionMode` 基础上，可通过 `permissionPolicy` 对特定工具进行细粒度控制：

```json
{
  "acp-session-manager": {
    "permissionMode": "approve-reads",
    "permissionPolicy": {
      "autoApprove": [
        "Read",
        "Glob",
        "Grep",
        "Bash:ls *",
        "Bash:git status"
      ],
      "autoDeny": [
        "Bash:rm *",
        "Bash:git push *"
      ],
      "escalate": [
        "Write",
        "Edit"
      ],
      "defaultAction": "escalate"
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `autoApprove` | string[] | 匹配的工具/命令模式自动允许，无需审批 |
| `autoDeny` | string[] | 匹配的工具/命令模式自动拒绝 |
| `escalate` | string[] | 匹配的工具/命令强制上报到主 Agent 审批 |
| `defaultAction` | string | 未匹配任何规则时的默认行为：`"approve"` / `"deny"` / `"escalate"` |

规则匹配支持 `工具名` 或 `工具名:命令模式`（glob 风格），按 `autoDeny` → `autoApprove` → `escalate` → `defaultAction` 优先级依次判定。

#### allowedTools（会话级工具白名单）

在 `acp_launch` 拉起会话时，可通过 `sessionOptions.allowedTools` 限制子 Agent 可用的工具集：

```json
{
  "sessionOptions": {
    "allowedTools": ["Read", "Grep", "Glob", "Bash"],
    "maxTurns": 10,
    "model": "claude-sonnet-4-20250514"
  }
}
```

此配置仅在创建新会话时生效，已有持久会话不受影响。
