/**
 * ACP Session Manager Service
 *
 * 核心服务层：直接集成 acpx runtime，会话池管理。
 * 通过 onPermissionRequest 回调拦截权限请求，调用 openclaw gateway 的
 * plugin.approval.request/waitDecision 展示原生审批 UI 并等待操作者决策。
 */

import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntime,
  type AcpRuntimeOptions,
  type AcpRuntimeHandle,
  type AcpRuntimeEvent,
  type AcpRuntimeTurn,
  type AcpPermissionRequest,
  type AcpPermissionDecision,
} from "acpx/runtime";

import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";

import type {
  ManagedAcpSession,
  AcpSessionLaunchParams,
  AcpSessionStatus,
  TurnResult,
  SessionEvent,
} from "./types.js";

export type { AcpRuntime };

const LOG_PREFIX = "[acp-sm]";

const DEFAULT_AGENTS: Record<string, string> = {
  qoder: "qodercli --acp",
  claude: "npx -y @agentclientprotocol/claude-agent-acp@latest",
  codex: "npx -y @agentclientprotocol/codex-acp@latest",
  gemini: "gemini --acp",
  opencode: "npx -y opencode-ai acp",
  kimi: "kimi acp",
  qwen: "qwen --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  kilocode: "npx -y @kilocode/cli acp",
  trae: "traecli acp serve",
  openclaw: "openclaw acp",
};

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, new Date().toISOString(), ...args);
}

function logWarn(...args: unknown[]): void {
  console.warn(LOG_PREFIX, new Date().toISOString(), ...args);
}

function logError(...args: unknown[]): void {
  console.error(LOG_PREFIX, new Date().toISOString(), ...args);
}

export type ServiceEventCallback = (event: SessionEvent) => void | Promise<void>;

export type AcpSessionManagerConfig = {
  maxSessions?: number;
  sessionTtlHours?: number;
  approvalTimeoutMs?: number;
  cwd?: string;
  stateDir?: string;
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
  /**
   * Which gateway approval method to use for surfacing permission popups.
   * - "exec" (default): uses exec.approval.request, which the ACP translator's
   *   handleGatewayEvent natively forwards to the Control UI.
   * - "plugin": uses plugin.approval.request (requires UI/translator support for
   *   plugin.approval.requested events).
   */
  approvalMode?: "exec" | "plugin";
  agents?: Record<string, string | { command: string; args?: string[] }>;
};

export class AcpSessionManagerService {
  private sessions = new Map<string, ManagedAcpSession>();
  private runtime: AcpRuntime | null = null;
  private eventCallbacks: ServiceEventCallback[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private activeTurns = new Map<string, { turn: AcpRuntimeTurn; collecting: Promise<void> }>();
  private acpSessionIdMap = new Map<string, string>();

  private maxSessions = 50;
  private sessionTtlMs = 24 * 60 * 60 * 1000;
  private approvalTimeoutMs = 5 * 60 * 1000;
  private approvalMode: "exec" | "plugin" = "exec";
  private runtimeConfig: AcpSessionManagerConfig = {};

  configure(config: AcpSessionManagerConfig | undefined | null): void {
    if (!config) return;
    log("configure:", JSON.stringify(config));
    if (typeof config.maxSessions === "number" && config.maxSessions > 0) {
      this.maxSessions = Math.floor(config.maxSessions);
    }
    if (typeof config.sessionTtlHours === "number" && config.sessionTtlHours > 0) {
      this.sessionTtlMs = Math.floor(config.sessionTtlHours * 60 * 60 * 1000);
    }
    if (typeof config.approvalTimeoutMs === "number" && config.approvalTimeoutMs >= 10_000) {
      this.approvalTimeoutMs = Math.floor(config.approvalTimeoutMs);
    }
    if (config.approvalMode === "exec" || config.approvalMode === "plugin") {
      this.approvalMode = config.approvalMode;
    }
    this.runtimeConfig = config;
  }

  start(): void {
    if (this.started) return;

    const cwd = this.runtimeConfig.cwd || process.cwd();
    const stateDir = this.runtimeConfig.stateDir || `${cwd}/.acp-sessions`;

    const rawAgents = this.runtimeConfig.agents;
    const agents: Record<string, string> = { ...DEFAULT_AGENTS };
    if (rawAgents) {
      for (const [name, val] of Object.entries(rawAgents)) {
        if (typeof val === "string") {
          agents[name.toLowerCase()] = val;
        } else if (val && typeof val === "object" && "command" in val) {
          const obj = val as { command: string; args?: string[] };
          agents[name.toLowerCase()] = obj.args ? `${obj.command} ${obj.args.join(" ")}` : obj.command;
        }
      }
    }

    log("start: cwd=" + cwd, "stateDir=" + stateDir, "permissionMode=" + (this.runtimeConfig.permissionMode || "approve-reads"));
    log("start: agents (" + Object.keys(agents).length + "):", JSON.stringify(agents));

    const options: AcpRuntimeOptions = {
      cwd,
      sessionStore: createFileSessionStore({ stateDir }),
      agentRegistry: createAgentRegistry({ overrides: agents }),
      permissionMode: this.runtimeConfig.permissionMode || "approve-reads",
      nonInteractivePermissions: "deny",
      onPermissionRequest: async (req, ctx) => {
        return this.handlePermissionRequest(req, ctx);
      },
    };

    this.runtime = createAcpRuntime(options);
    log("start: runtime created successfully");

    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60_000);
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    log("stop: shutting down, active sessions:", this.sessions.size, "active turns:", this.activeTurns.size);
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [, entry] of this.activeTurns) {
      entry.turn.cancel({ reason: "service_shutdown" }).catch(() => {});
    }
    this.activeTurns.clear();
    const activeSessions = [...this.sessions.values()].filter((s) => s.status === "running");
    await Promise.allSettled(
      activeSessions.map((s) => this.closeSession(s.sessionId, "service_shutdown")),
    );
    this.sessions.clear();
    this.started = false;
    log("stop: complete");
  }

  onEvent(callback: ServiceEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  async launchSession(params: AcpSessionLaunchParams, onUpdate?: (result: unknown) => void): Promise<ManagedAcpSession> {
    log("launchSession:", JSON.stringify({ agentId: params.agentId, task: params.task.slice(0, 100), mode: params.mode, cwd: params.cwd }));
    this.start();
    if (!this.runtime) throw new Error("Runtime unavailable");
    if (!params.agentId?.trim()) {
      throw new Error(`agentId is required but received ${JSON.stringify(params.agentId)}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      await this.cleanupExpiredSessions();
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Session pool full (max ${this.maxSessions})`);
      }
    }

    const sessionId = generateSessionId();
    const sessionKey = `acp-manager:${params.agentId}:${sessionId}`;
    log("launchSession: ensureSession sessionKey=" + sessionKey, "agent=" + params.agentId, "mode=" + (params.mode === "session" ? "persistent" : "oneshot"));

    const handle = await this.runtime.ensureSession({
      sessionKey,
      agent: params.agentId,
      mode: params.mode === "session" ? "persistent" : "oneshot",
      ...(params.cwd ? { cwd: params.cwd } : {}),
    });
    log("launchSession: session ensured, handle:", JSON.stringify({ sessionKey: handle.sessionKey, backend: handle.backend, acpxRecordId: handle.acpxRecordId }));

    const session: ManagedAcpSession = {
      sessionId,
      handle,
      agentId: params.agentId,
      status: "running",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      mode: params.mode || "run",
      cwd: params.cwd,
      model: params.model,
      output: "",
      toolCalls: [],
      parentSessionKey: params.parentSessionKey,
    };

    this.sessions.set(sessionId, session);
    this.emitEvent({ type: "session_created", sessionId, agentId: params.agentId });
    log("launchSession: executing first turn for", sessionId);

    await this.executeTurn(sessionId, params.task, onUpdate);
    const finalSession = this.sessions.get(sessionId) ?? session;
    log("launchSession: done, sessionId=" + sessionId, "status=" + finalSession.status);
    return finalSession;
  }

  async launchSessionBackground(params: AcpSessionLaunchParams): Promise<ManagedAcpSession> {
    log("launchSessionBackground:", JSON.stringify({ agentId: params.agentId, task: params.task.slice(0, 100), mode: params.mode, cwd: params.cwd }));
    this.start();
    if (!this.runtime) throw new Error("Runtime unavailable");
    if (!params.agentId?.trim()) {
      throw new Error(`agentId is required but received ${JSON.stringify(params.agentId)}`);
    }
    if (this.sessions.size >= this.maxSessions) {
      await this.cleanupExpiredSessions();
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Session pool full (max ${this.maxSessions})`);
      }
    }

    const sessionId = generateSessionId();
    const sessionKey = `acp-manager:${params.agentId}:${sessionId}`;

    const handle = await this.runtime.ensureSession({
      sessionKey,
      agent: params.agentId,
      mode: params.mode === "session" ? "persistent" : "oneshot",
      ...(params.cwd ? { cwd: params.cwd } : {}),
    });

    const session: ManagedAcpSession = {
      sessionId,
      handle,
      agentId: params.agentId,
      status: "running",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      mode: params.mode || "run",
      cwd: params.cwd,
      model: params.model,
      output: "",
      toolCalls: [],
      parentSessionKey: params.parentSessionKey,
    };

    this.sessions.set(sessionId, session);
    this.emitEvent({ type: "session_created", sessionId, agentId: params.agentId });
    log("launchSessionBackground: session created, starting turn in background for", sessionId);

    void this.executeTurn(sessionId, params.task);
    return session;
  }

  async sendMessage(sessionId: string, message: string, onUpdate?: (result: unknown) => void): Promise<TurnResult> {
    log("sendMessage:", sessionId, "message=" + message.slice(0, 100));
    const session = this.getSessionOrThrow(sessionId);
    if (session.status !== "running") {
      throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
    }
    return this.executeTurn(sessionId, message, onUpdate);
  }

  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    log("cancelSession:", sessionId, "reason=" + (reason || "none"));
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn) {
      log("cancelSession: cancelling active turn for", sessionId);
      await activeTurn.turn.cancel({ reason });
      this.activeTurns.delete(sessionId);
    }
    await this.runtime.cancel({ handle: session.handle, reason });
    session.status = "cancelled";
    session.lastActiveAt = Date.now();
    this.emitEvent({ type: "session_cancelled", sessionId });
    log("cancelSession: done", sessionId);
  }

  async closeSession(sessionId: string, reason?: string): Promise<void> {
    log("closeSession:", sessionId, "reason=" + (reason || "user_requested"));
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");
    const activeTurn = this.activeTurns.get(sessionId);
    if (activeTurn) {
      await activeTurn.turn.cancel({ reason: "closing" }).catch(() => {});
      this.activeTurns.delete(sessionId);
    }
    try {
      await this.runtime.close({ handle: session.handle, reason: reason || "user_requested" });
    } catch { /* ignore */ }
    session.status = "completed";
    session.lastActiveAt = Date.now();
    this.sessions.delete(sessionId);
    log("closeSession: done", sessionId);
  }

  async setConfig(sessionId: string, key: string, value: string): Promise<void> {
    log("setConfig:", sessionId, key + "=" + value);
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime?.setConfigOption) {
      throw new Error("Runtime does not support setConfigOption");
    }
    await this.runtime.setConfigOption({ handle: session.handle, key, value });
    session.lastActiveAt = Date.now();
    if (key === "model") session.model = value;
  }

  listSessions(filter?: { status?: AcpSessionStatus }): ManagedAcpSession[] {
    let sessions = [...this.sessions.values()];
    if (filter?.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }
    log("listSessions: filter=" + JSON.stringify(filter), "count=" + sessions.length);
    return sessions;
  }

  getSession(sessionId: string): ManagedAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ===== Private =====

  private async handlePermissionRequest(
    req: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision | undefined> {
    log("handlePermissionRequest: acpSessionId=" + req.sessionId, "toolTitle=" + (req.raw.toolCall?.title || "unknown"), "kind=" + (req.inferredKind || "unknown"));

    const sessionId = this.findSessionIdByAcpSessionId(req.sessionId);
    if (!sessionId) {
      logWarn("handlePermissionRequest: could not find managed session for acpSessionId=" + req.sessionId);
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    const parentSessionKey = session?.parentSessionKey;
    log("handlePermissionRequest: mapped to managed sessionId=" + sessionId, "parentSessionKey=" + (parentSessionKey || "none"));

    const toolTitle = req.raw.toolCall?.title || "Permission Request";
    const toolName = req.raw.toolCall?.title?.split(":")[0]?.trim();
    const description = this.buildPermissionDescription(req);
    const timeoutMs = this.approvalTimeoutMs;
    const gatewayTimeoutMs = timeoutMs + 10_000;
    const mode = this.approvalMode;
    log("handlePermissionRequest: approvalMode=" + mode);

    try {
      let requestResult: { id?: string; decision?: string | null } | undefined;

      if (mode === "exec") {
        // exec.approval.request is natively forwarded to the Control UI by the
        // ACP translator's handleGatewayEvent (exec.approval.requested).
        const commandText = description || toolTitle;
        requestResult = await callGatewayTool<{ id?: string; decision?: string | null }>(
          "exec.approval.request",
          { timeoutMs: gatewayTimeoutMs },
          {
            command: commandText.slice(0, 4000),
            host: "agent",
            ask: "on",
            agentId: session?.agentId,
            sessionKey: parentSessionKey,
            timeoutMs,
            twoPhase: true,
          },
          { expectFinal: false },
        );
      } else {
        requestResult = await callGatewayTool<{ id?: string; decision?: string | null }>(
          "plugin.approval.request",
          { timeoutMs: gatewayTimeoutMs },
          {
            pluginId: "acp-session-manager",
            title: toolTitle.slice(0, 80),
            description: description.slice(0, 256),
            severity: "warning",
            toolName,
            agentId: session?.agentId,
            sessionKey: parentSessionKey,
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            timeoutMs,
            twoPhase: true,
          },
          { expectFinal: false },
        );
      }

      const approvalId = requestResult?.id;
      if (!approvalId) {
        logWarn("handlePermissionRequest: " + mode + ".approval.request returned no id, rejecting");
        return { outcome: "reject_once" };
      }
      log("handlePermissionRequest: approval created, id=" + approvalId);

      let decision: string | null | undefined;
      if (Object.hasOwn(requestResult ?? {}, "decision")) {
        decision = requestResult.decision;
      } else {
        const waitResult = await this.waitForApprovalDecision(mode, approvalId, gatewayTimeoutMs, ctx.signal);
        decision = waitResult?.decision;
      }

      log("handlePermissionRequest: decision=" + (decision ?? "null"));

      if (decision === "allow-once") return { outcome: "allow_once" };
      if (decision === "allow-always") return { outcome: "allow_always" };
      if (decision === "deny") return { outcome: "reject_once" };
      return { outcome: "reject_once" };
    } catch (err) {
      logError("handlePermissionRequest: gateway call failed:", err instanceof Error ? err.message : String(err));
      return { outcome: "reject_once" };
    }
  }

  private async waitForApprovalDecision(
    mode: "exec" | "plugin",
    approvalId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ id?: string; decision?: string | null } | undefined> {
    const method = mode === "exec" ? "exec.approval.waitDecision" : "plugin.approval.waitDecision";
    const waitPromise = callGatewayTool<{ id?: string; decision?: string | null }>(
      method,
      { timeoutMs },
      { id: approvalId },
    );

    if (!signal) return waitPromise;

    return Promise.race([
      waitPromise,
      new Promise<undefined>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]).catch((err) => {
      logWarn("handlePermissionRequest: waitDecision aborted:", err instanceof Error ? err.message : String(err));
      return undefined;
    });
  }

  private findSessionIdByAcpSessionId(acpSessionId: string): string | undefined {
    if (this.acpSessionIdMap.has(acpSessionId)) {
      return this.acpSessionIdMap.get(acpSessionId);
    }

    for (const [id, session] of this.sessions) {
      if (session.handle.agentSessionId === acpSessionId) {
        this.acpSessionIdMap.set(acpSessionId, id);
        return id;
      }
      if (session.handle.backendSessionId === acpSessionId) {
        this.acpSessionIdMap.set(acpSessionId, id);
        return id;
      }
    }

    // Fallback: if there's exactly one session with an active turn, it must be the one
    // requesting permission (permission requests only fire during active turns)
    const activeTurnSessionIds = [...this.activeTurns.keys()];
    if (activeTurnSessionIds.length === 1) {
      const id = activeTurnSessionIds[0];
      this.acpSessionIdMap.set(acpSessionId, id);
      log("findSessionIdByAcpSessionId: mapped acpSessionId=" + acpSessionId + " to " + id + " (only active turn)");
      return id;
    }

    // Multiple active turns: match by the session that has a pending tool_call with status=pending
    for (const [id, session] of this.sessions) {
      if (this.activeTurns.has(id) && session.status === "running") {
        const lastToolCall = session.toolCalls[session.toolCalls.length - 1];
        if (lastToolCall?.status === "pending") {
          this.acpSessionIdMap.set(acpSessionId, id);
          log("findSessionIdByAcpSessionId: mapped acpSessionId=" + acpSessionId + " to " + id + " (has pending tool_call)");
          return id;
        }
      }
    }

    logWarn("findSessionIdByAcpSessionId: could not resolve acpSessionId=" + acpSessionId, "activeTurns=" + activeTurnSessionIds.length);
    return undefined;
  }

  private buildPermissionDescription(req: AcpPermissionRequest): string {
    const parts: string[] = [];
    const raw = req.raw;
    if (raw.toolCall?.title) parts.push(`Tool: ${raw.toolCall.title}`);
    if (raw.toolCall?.rawInput) {
      const input = raw.toolCall.rawInput as Record<string, unknown>;
      if (input.command) parts.push(`Command: ${String(input.command)}`);
      if (input.path) parts.push(`Path: ${String(input.path)}`);
    }
    if (req.inferredKind) parts.push(`Kind: ${req.inferredKind}`);
    return parts.join("\n") || "Permission requested";
  }

  private progressThrottleMap = new Map<string, number>();

  private shouldThrottleProgress(sessionId: string): boolean {
    const now = Date.now();
    const last = this.progressThrottleMap.get(sessionId) || 0;
    if (now - last < 2000) return false;
    this.progressThrottleMap.set(sessionId, now);
    return true;
  }

  private executeTurn(sessionId: string, text: string, onUpdate?: (result: unknown) => void): Promise<TurnResult> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");

    const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log("executeTurn: sessionId=" + sessionId, "requestId=" + requestId, "text=" + text.slice(0, 80), "streaming=" + !!onUpdate);

    const turn = this.runtime.startTurn({
      handle: session.handle,
      text,
      mode: "prompt",
      requestId,
    });

    return new Promise<TurnResult>((resolve) => {
      const collectEvents = async () => {
        try {
          let eventCount = 0;
          for await (const event of turn.events) {
            eventCount++;
            switch (event.type) {
              case "text_delta":
                session.output += event.text;
                if (onUpdate && this.shouldThrottleProgress(sessionId)) {
                  const line = session.output.split("\n").filter(Boolean).pop() || "";
                  onUpdate({
                    content: [{ type: "text", text: line.slice(-200) }],
                    details: { status: "running" },
                    progress: {
                      text: `[${session.agentId}] ${line.slice(-120)}`,
                      visibility: "channel",
                      privacy: "public",
                    },
                  });
                }
                break;
              case "tool_call":
                log("executeTurn: [event] tool_call:", event.title || event.text, "status=" + (event.status || "n/a"), "toolCallId=" + (event.toolCallId || "n/a"));
                session.toolCalls.push({
                  toolCallId: event.toolCallId || requestId,
                  toolName: event.text,
                  title: event.title,
                  status: event.status,
                  timestamp: Date.now(),
                });
                if (onUpdate) {
                  onUpdate({
                    content: [{ type: "text", text: `${event.title || event.text} (${event.status || "running"})` }],
                    details: { status: "running" },
                    progress: {
                      text: `[${session.agentId}] ${event.title || event.text} (${event.status || "..."})`,
                      visibility: "channel",
                      privacy: "public",
                    },
                  });
                }
                break;
              case "status":
                log("executeTurn: [event] status:", (event as any).text);
                break;
              default:
                break;
            }
          }
          log("executeTurn: event stream ended, total events=" + eventCount, "sessionId=" + sessionId);

          const result = await turn.result;
          session.lastActiveAt = Date.now();
          this.activeTurns.delete(sessionId);

          log("executeTurn: turn result:", JSON.stringify(result));

          if (result.status === "completed") {
            session.lastStopReason = result.stopReason;
            session.status = session.mode === "session" ? "running" : "completed";
            this.emitEvent({ type: "session_completed", sessionId, output: session.output });
            resolve({ status: "completed", output: session.output, stopReason: result.stopReason });
          } else if (result.status === "failed") {
            session.status = "failed";
            session.error = result.error.message;
            logError("executeTurn: turn FAILED:", result.error.message, "code=" + (result.error.code || "none"));
            this.emitEvent({ type: "session_failed", sessionId, error: result.error.message });
            resolve({ status: "failed", error: result.error.message });
          } else {
            session.status = "cancelled";
            log("executeTurn: turn cancelled");
            this.emitEvent({ type: "session_cancelled", sessionId });
            resolve({ status: "cancelled" });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logError("executeTurn: EXCEPTION:", errorMsg);
          session.status = "failed";
          session.error = errorMsg;
          session.lastActiveAt = Date.now();
          this.activeTurns.delete(sessionId);
          this.emitEvent({ type: "session_failed", sessionId, error: errorMsg });
          resolve({ status: "failed", error: errorMsg });
        }
      };

      const collecting = collectEvents();
      this.activeTurns.set(sessionId, { turn, collecting });
    });
  }

  private getSessionOrThrow(sessionId: string): ManagedAcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt > this.sessionTtlMs) {
        log("cleanupExpiredSessions: expired session", id, "lastActive=" + new Date(session.lastActiveAt).toISOString());
        const activeTurn = this.activeTurns.get(id);
        if (activeTurn) {
          await activeTurn.turn.cancel({ reason: "ttl_expired" }).catch(() => {});
          this.activeTurns.delete(id);
        }
        if (this.runtime) {
          try {
            await this.runtime.close({ handle: session.handle, reason: "ttl_expired" });
          } catch { /* ignore */ }
        }
        this.sessions.delete(id);
      }
    }
  }

  private emitEvent(event: SessionEvent): void {
    log("event:", event.type, "sessionId" in event ? event.sessionId : "");
    for (const cb of this.eventCallbacks) {
      try {
        const result = cb(event);
        if (result && typeof (result as any).catch === "function") {
          (result as Promise<void>).catch((err) => {
            logError("emitEvent: async callback error:", err instanceof Error ? err.message : String(err));
          });
        }
      } catch (err) {
        logError("emitEvent: sync callback error:", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

function generateSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
