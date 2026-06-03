# ACP Session Manager - Architecture

## Overview

ACP Session Manager is an OpenClaw plugin that manages ACP (Agent Client Protocol) sub-sessions.
It allows the main OpenClaw agent to delegate tasks to external coding agents (qoder, claude, codex, etc.)
and manages the full lifecycle including permission approvals via the native OpenClaw UI.

---

## Session Interaction Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway Process                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    acp_launch/send     ┌─────────────────────┐   │
│  │  Main Agent  │ ────────────────────►  │  ACP Session Manager │   │
│  │  (Parent     │                        │  Plugin (Service)    │   │
│  │   Session)   │ ◄────────────────────  │                     │   │
│  │              │   tool result / event   │  - createAcpRuntime │   │
│  └──────────────┘   injection            │  - session pool     │   │
│        │                                 │  - event callbacks   │   │
│        │                                 └──────────┬──────────┘   │
│        │                                            │              │
│        │  scheduleSessionTurn /                     │ startTurn /  │
│        │  enqueueNextTurnInjection                  │ ensureSession│
│        │  (event-injector.ts)                       │              │
│        │                                            ▼              │
│        │                                 ┌─────────────────────┐   │
│        │                                 │   acpx Runtime      │   │
│        │                                 │   (createAcpRuntime)│   │
│        │                                 └──────────┬──────────┘   │
│        │                                            │              │
└────────┼────────────────────────────────────────────┼──────────────┘
         │                                            │
         │                                            │ ACP Protocol
         │                                            │ (JSON-RPC over stdio)
         │                                            ▼
         │                                 ┌─────────────────────┐
         │                                 │  External Agent      │
         │                                 │  (qodercli --acp)   │
         │                                 │                     │
         │                                 │  - Executes task    │
         │                                 │  - Requests perms   │
         │                                 │  - Returns output   │
         │                                 └─────────────────────┘
         │
         ▼
┌─────────────────┐
│  Control UI     │
│  (Web/TUI)      │
│                 │
│  Shows approval │
│  popups         │
└─────────────────┘
```

---

## Tool Call Flow

### Foreground Mode (default)

```
User → Main Agent → acp_launch(task, mode=run)
                         │
                         ▼
              service.launchSession()
                         │
                         ├── runtime.ensureSession() → spawn qoder process
                         │
                         ├── executeTurn(task) ─── BLOCKS until turn completes ───
                         │       │                                               │
                         │       ├── events: text_delta, tool_call, status       │
                         │       │                                               │
                         │       ├── [if permission needed] ──────────┐          │
                         │       │                                    ▼          │
                         │       │                          plugin.approval      │
                         │       │                          .request → UI popup  │
                         │       │                                    │          │
                         │       │                          user clicks Allow    │
                         │       │                                    │          │
                         │       │                          decision returns     │
                         │       │   ◄────────────────────────────────┘          │
                         │       │                                               │
                         │       └── turn.result → completed/failed              │
                         │                                                       │
                         └── return session (with output) ◄──────────────────────┘
                         │
                         ▼
              Tool result → Main Agent continues
```

### Background Mode (background=true)

```
User → Main Agent → acp_launch(task, background=true)
                         │
                         ▼
              service.launchSessionBackground()
                         │
                         ├── runtime.ensureSession()
                         │
                         ├── void executeTurn(task) ─── runs in background ───►
                         │
                         └── return session immediately (status=running)
                         │
                         ▼
              Tool result → Main Agent continues with other work
                         
                         ... later, in background ...
                         
              executeTurn completes
                         │
                         ├── emitEvent("session_completed")
                         │
                         ▼
              event-injector.ts
                         │
                         ├── formatSessionCompletionNotice()
                         │
                         ├── api.session.workflow.enqueueNextTurnInjection()
                         │   (injects completion notice into parent session context)
                         │
                         └── [on failure] api.session.workflow.scheduleSessionTurn()
                             (wakes parent session to handle error)
```

---

## Approval Chain Architecture

### Approval Mode (configurable)

The plugin surfaces permission popups via one of two gateway methods, selected by
the `approvalMode` config option:

| Mode | Gateway Method | Event Broadcast | UI Support |
|------|----------------|-----------------|------------|
| `exec` (default) | `exec.approval.request` | `exec.approval.requested` | Natively handled by ACP translator's `handleGatewayEvent` |
| `plugin` | `plugin.approval.request` | `plugin.approval.requested` | Requires UI/translator support for plugin approval events |

> **Why `exec` is the default**: The ACP translator's `handleGatewayEvent` only
> forwards `exec.approval.requested` events to the Control UI. `plugin.approval.requested`
> is not handled by the translator, so popups would not appear unless the UI is
> extended. Use `plugin` mode only if your environment supports it.

Configure via:
```bash
openclaw config set plugins.entries.acp-session-manager.config.approvalMode exec
# or
openclaw config set plugins.entries.acp-session-manager.config.approvalMode plugin
```

### Permission Request Flow

```
                    Permission Request Flow
                    ========================

┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌───────────┐
│  qoder   │     │  acpx        │     │  acp-session │     │  OpenClaw │
│  agent   │     │  runtime     │     │  -manager    │     │  Gateway  │
└────┬─────┘     └──────┬───────┘     └──────┬───────┘     └─────┬─────┘
     │                   │                    │                    │
     │ tool_call(write)  │                    │                    │
     │──────────────────►│                    │                    │
     │                   │                    │                    │
     │                   │ onPermissionRequest │                    │
     │                   │───────────────────►│                    │
     │                   │                    │                    │
     │                   │                    │ callGatewayTool    │
     │                   │                    │ (exec|plugin       │
     │                   │                    │  .approval.request)│
     │                   │                    │───────────────────►│
     │                   │                    │                    │
     │                   │                    │                    │──► broadcast
     │                   │                    │                    │    (exec|plugin)
     │                   │                    │                    │    .approval
     │                   │                    │                    │    .requested
     │                   │                    │                    │         │
     │                   │                    │                    │         ▼
     │                   │                    │                    │  ┌────────────┐
     │                   │                    │                    │  │ Control UI │
     │                   │                    │                    │  │  (popup)   │
     │                   │                    │                    │  └─────┬──────┘
     │                   │                    │                    │        │
     │                   │                    │                    │  user clicks
     │                   │                    │                    │  "Allow Once"
     │                   │                    │                    │        │
     │                   │                    │                    │◄───────┘
     │                   │                    │                    │ (exec|plugin)
     │                   │                    │                    │ .approval.resolve
     │                   │                    │◄───────────────────│
     │                   │                    │  decision:         │
     │                   │                    │  "allow-once"      │
     │                   │                    │                    │
     │                   │◄───────────────────│                    │
     │                   │ AcpPermissionDecision                   │
     │                   │ {outcome:"allow_once"}                  │
     │                   │                    │                    │
     │◄──────────────────│                    │                    │
     │ permission granted│                    │                    │
     │                   │                    │                    │
     │ execute & return  │                    │                    │
     │──────────────────►│                    │                    │
     │                   │ event: tool_call   │                    │
     │                   │ status=completed   │                    │
     │                   │───────────────────►│                    │
     │                   │                    │                    │
```

### Approval Decisions

| Gateway Decision | ACP Decision | Effect |
|-----------------|--------------|--------|
| `allow-once` | `{ outcome: "allow_once" }` | Permit this single operation |
| `allow-always` | `{ outcome: "allow_always" }` | Persist permission for this type |
| `deny` | `{ outcome: "reject_once" }` | Reject the operation |
| timeout/error | `{ outcome: "reject_once" }` | Fallback to reject |

### Permission Modes

| Mode | Behavior |
|------|----------|
| `approve-all` | All operations auto-approved, no UI popup |
| `approve-reads` | Read/search auto-approved; write/execute triggers popup |
| `deny-all` | All operations denied without popup |

---

## Parent-Child Session Communication

### How ACP sessions notify the parent session

1. **Foreground mode**: `acp_launch` / `acp_send` blocks until turn completes, result returned directly in the tool response.

2. **Background mode**: The `event-injector.ts` hook listens for service events and injects notifications into the parent session:

| Event | Action |
|-------|--------|
| `session_completed` | Inject completion notice with output preview via `enqueueNextTurnInjection` |
| `session_failed` | Inject failure notice + wake parent session via `scheduleSessionTurn` |

3. **Approval during foreground mode**: The `callGatewayTool("plugin.approval.request")` call blocks the turn. The UI popup appears. When the user decides, the gateway returns the decision, unblocking the turn. The parent agent is unaware of the approval — it just sees the turn taking longer.

### Session State Machine

```
             acp_launch
                 │
                 ▼
          ┌─────────────┐
          │ initializing │
          └──────┬──────┘
                 │ ensureSession success
                 ▼
          ┌─────────────┐
          │   running    │◄──────────────────┐
          └──────┬──────┘                    │
                 │                           │
        ┌────────┼────────┐                  │
        │        │        │                  │
        ▼        ▼        ▼                  │
  ┌──────────┐ ┌──────┐ ┌──────────┐        │
  │completed │ │failed│ │cancelled │        │
  └──────────┘ └──────┘ └──────────┘        │
        │                                    │
        │ (session mode only)                │
        └── acp_send ────────────────────────┘
```

---

## Key Files

| File | Role |
|------|------|
| `src/service.ts` | Core service: acpx runtime, session pool, turn execution, permission handling |
| `src/index.ts` | Plugin entry: registers tools, service, event hooks |
| `src/tools/acp-launch.ts` | Launch tool with foreground/background modes |
| `src/tools/acp-send.ts` | Send message to running session |
| `src/tools/acp-list.ts` | List active sessions with status |
| `src/tools/acp-cancel.ts` | Cancel running session |
| `src/tools/acp-close.ts` | Close and cleanup session |
| `src/tools/acp-config.ts` | Update session config (model, etc.) |
| `src/hooks/event-injector.ts` | Injects completion/failure notices into parent session |
| `src/types.ts` | Core types (re-exports acpx types + plugin-specific) |
| `openclaw.plugin.json` | Plugin manifest with config schema |

---

## Configuration

```jsonc
// openclaw config set plugins.entries.acp-session-manager.config.<key> <value>
{
  "maxSessions": 50,           // Max concurrent sessions
  "sessionTtlHours": 24,       // Auto-cleanup after inactivity
  "approvalTimeoutMs": 300000,  // 5 min approval timeout
  "permissionMode": "approve-reads", // Permission policy
  "approvalMode": "exec",        // Approval method: "exec" (default) or "plugin"
  "cwd": "/path/to/workspace",  // Default working directory
  "agents": {                   // Custom agent command overrides
    "my-agent": "my-cli --acp"
  }
}
```

### Built-in Agents (12)

| Agent | Command |
|-------|---------|
| qoder | `qodercli --acp` |
| claude | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| codex | `npx -y @agentclientprotocol/codex-acp@latest` |
| gemini | `gemini --acp` |
| opencode | `npx -y opencode-ai acp` |
| kimi | `kimi acp` |
| qwen | `qwen --acp` |
| cursor | `cursor-agent acp` |
| copilot | `copilot --acp --stdio` |
| kilocode | `npx -y @kilocode/cli acp` |
| trae | `traecli acp serve` |
| openclaw | `openclaw acp` |
