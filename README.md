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

## 安装

将此插件注册到 OpenClaw 的 Plugin 配置中。

## 开发

```bash
pnpm install
pnpm build
```
