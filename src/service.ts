/**
 * ACP Session Manager Service
 *
 * 核心服务层：直接集成 acpx runtime，会话池管理、审批队列。
 * 通过 onPermissionRequest 回调拦截权限请求，实现审批透出。
 *
 * 关键设计：turn 执行为非阻塞模式。当 permission request 到达时，
 * executeTurn 立即返回 pending_approval 状态，turn 在后台挂起等待决策。
 * 调用者可通过 acp_approve 解决审批，turn 自动恢复执行。
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

import type {
  ManagedAcpSession,
  AcpSessionLaunchParams,
  AcpSessionStatus,
  PendingApproval,
  ApprovalDecision,
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

export type ServiceEventCallback = (event: SessionEvent) => void;

export type AcpSessionManagerConfig = {
  maxSessions?: number;
  sessionTtlHours?: number;
  approvalTimeoutMs?: number;
  cwd?: string;
  stateDir?: string;
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
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
    this.runtimeConfig = config;
  }

  getApprovalTimeoutMs(): number {
    return this.approvalTimeoutMs;
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

  async launchSession(params: AcpSessionLaunchParams): Promise<ManagedAcpSession> {
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
      pendingApprovals: [],
      parentSessionKey: params.parentSessionKey,
    };

    this.sessions.set(sessionId, session);
    this.emitEvent({ type: "session_created", sessionId, agentId: params.agentId });
    log("launchSession: executing first turn for", sessionId);

    await this.executeTurn(sessionId, params.task);
    const finalSession = this.sessions.get(sessionId) ?? session;
    log("launchSession: done, sessionId=" + sessionId, "status=" + finalSession.status, "pendingApprovals=" + finalSession.pendingApprovals.length);
    return finalSession;
  }

  async sendMessage(sessionId: string, message: string): Promise<TurnResult> {
    log("sendMessage:", sessionId, "message=" + message.slice(0, 100));
    const session = this.getSessionOrThrow(sessionId);
    if (session.status === "pending_approval") {
      logWarn("sendMessage: blocked, session", sessionId, "is pending_approval");
      throw new Error(
        `Session ${sessionId} is waiting for approval. Use acp_approve to resolve pending approvals first.`,
      );
    }
    if (session.status !== "running") {
      throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
    }
    return this.executeTurn(sessionId, message);
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

  addPendingApproval(approval: PendingApproval): void {
    const session = this.sessions.get(approval.sessionId);
    if (session) {
      session.pendingApprovals.push(approval);
      session.status = "pending_approval";
      session.lastActiveAt = Date.now();
      log("addPendingApproval: sessionId=" + approval.sessionId, "approvalId=" + approval.approvalId, "title=" + approval.title, "toolName=" + (approval.toolName || "unknown"));
      if (session._approvalSignal) {
        log("addPendingApproval: firing _approvalSignal to unblock executeTurn");
        session._approvalSignal();
        session._approvalSignal = undefined;
      }
      this.emitEvent({ type: "approval_requested", sessionId: approval.sessionId, approval });
    } else {
      logWarn("addPendingApproval: session not found for", approval.sessionId);
    }
  }

  resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    log("resolveApproval:", sessionId, "approvalId=" + approvalId, "decision=" + decision);
    const session = this.sessions.get(sessionId);
    if (!session) {
      logWarn("resolveApproval: session not found", sessionId);
      return false;
    }
    const idx = session.pendingApprovals.findIndex((a) => a.approvalId === approvalId);
    if (idx === -1) {
      logWarn("resolveApproval: approval not found", approvalId, "in session", sessionId);
      return false;
    }
    const approval = session.pendingApprovals[idx]!;
    if (approval.resolve) {
      log("resolveApproval: calling resolver callback, decision=" + decision);
      approval.resolve(decision);
    }
    session.pendingApprovals.splice(idx, 1);
    session.lastActiveAt = Date.now();
    if (session.pendingApprovals.length === 0 && session.status === "pending_approval") {
      session.status = "running";
      log("resolveApproval: no more pending approvals, session status -> running");
    }
    this.emitEvent({ type: "approval_resolved", sessionId, approvalId, decision });
    return true;
  }

  getPendingApprovals(): PendingApproval[] {
    const all: PendingApproval[] = [];
    for (const session of this.sessions.values()) {
      all.push(...session.pendingApprovals);
    }
    return all;
  }

  // ===== Private =====

  private async handlePermissionRequest(
    req: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ): Promise<AcpPermissionDecision | undefined> {
    log("handlePermissionRequest: acpSessionId=" + req.sessionId, "toolTitle=" + (req.raw.toolCall?.title || "unknown"), "kind=" + (req.inferredKind || "unknown"));
    log("handlePermissionRequest: raw toolCall:", JSON.stringify({
      title: req.raw.toolCall?.title,
      kind: req.raw.toolCall?.kind,
      rawInput: req.raw.toolCall?.rawInput,
    }));

    const sessionId = this.findSessionIdByAcpSessionId(req.sessionId);
    if (!sessionId) {
      logWarn("handlePermissionRequest: could not find managed session for acpSessionId=" + req.sessionId);
      return undefined;
    }
    log("handlePermissionRequest: mapped to managed sessionId=" + sessionId);

    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const toolTitle = req.raw.toolCall?.title || "Permission Request";
    const toolName = req.raw.toolCall?.title?.split(":")[0]?.trim();

    const approval: PendingApproval = {
      approvalId,
      sessionId,
      toolName,
      title: toolTitle,
      description: this.buildPermissionDescription(req),
      options: [
        { id: "allow_once", label: "Allow Once", description: "Allow this action one time" },
        { id: "allow_always", label: "Allow Always", description: "Always allow this type of action" },
        { id: "reject", label: "Reject", description: "Deny this action" },
      ],
      timestamp: Date.now(),
      timeoutMs: this.approvalTimeoutMs,
    };

    log("handlePermissionRequest: created approval approvalId=" + approvalId, "timeoutMs=" + this.approvalTimeoutMs, "waiting for decision...");

    return new Promise<AcpPermissionDecision | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      approval.resolve = (decision: ApprovalDecision) => {
        if (timer) clearTimeout(timer);
        const acpDecision = this.mapDecisionToAcpDecision(decision);
        log("handlePermissionRequest: resolved approvalId=" + approvalId, "decision=" + decision, "-> acpOutcome=" + acpDecision.outcome);
        resolve(acpDecision);
      };

      this.addPendingApproval(approval);

      timer = setTimeout(() => {
        logWarn("handlePermissionRequest: TIMEOUT approvalId=" + approvalId, "after", this.approvalTimeoutMs + "ms, auto-rejecting");
        this.resolveApproval(sessionId, approvalId, "reject");
        resolve({ outcome: "reject_once" });
      }, this.approvalTimeoutMs);

      ctx.signal.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        logWarn("handlePermissionRequest: ABORTED approvalId=" + approvalId);
        this.resolveApproval(sessionId, approvalId, "cancel");
        resolve({ outcome: "cancel" });
      }, { once: true });
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

  private mapDecisionToAcpDecision(decision: ApprovalDecision): AcpPermissionDecision {
    switch (decision) {
      case "allow_once": return { outcome: "allow_once" };
      case "allow_always": return { outcome: "allow_always" };
      case "reject": return { outcome: "reject_once" };
      case "cancel": return { outcome: "cancel" };
    }
  }

  private executeTurn(sessionId: string, text: string): Promise<TurnResult> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");

    const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log("executeTurn: sessionId=" + sessionId, "requestId=" + requestId, "text=" + text.slice(0, 80));

    const turn = this.runtime.startTurn({
      handle: session.handle,
      text,
      mode: "prompt",
      requestId,
    });

    let approvalSignalResolve: (() => void) | undefined;
    const approvalArrived = new Promise<void>((resolve) => {
      approvalSignalResolve = resolve;
    });
    session._approvalSignal = approvalSignalResolve;

    const turnCompleted = new Promise<TurnResult>((resolve) => {
      const collectEvents = async () => {
        try {
          let eventCount = 0;
          for await (const event of turn.events) {
            eventCount++;
            switch (event.type) {
              case "text_delta":
                session.output += event.text;
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
          session._approvalSignal = undefined;

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
          session._approvalSignal = undefined;
          this.emitEvent({ type: "session_failed", sessionId, error: errorMsg });
          resolve({ status: "failed", error: errorMsg });
        }
      };

      const collecting = collectEvents();
      this.activeTurns.set(sessionId, { turn, collecting });
    });

    return Promise.race([
      turnCompleted,
      approvalArrived.then((): TurnResult => {
        const firstApproval = session.pendingApprovals[0];
        log("executeTurn: EARLY RETURN due to pending_approval, approvalId=" + (firstApproval?.approvalId || "unknown"));
        return {
          status: "pending_approval",
          output: session.output,
          pendingApprovalId: firstApproval?.approvalId,
        };
      }),
    ]);
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
      try { cb(event); } catch { /* swallow */ }
    }
  }
}

function generateSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
