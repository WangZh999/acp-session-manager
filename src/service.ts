/**
 * ACP Session Manager Service
 *
 * 核心服务层：直接集成 acpx runtime，会话池管理、审批队列。
 * 通过 onPermissionRequest 回调拦截权限请求，实现审批透出。
 */

import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntime,
  type AcpRuntimeOptions,
  type AcpRuntimeHandle,
  type AcpRuntimeEvent,
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

export type ServiceEventCallback = (event: SessionEvent) => void;

export type AcpSessionManagerConfig = {
  maxSessions?: number;
  sessionTtlHours?: number;
  approvalTimeoutMs?: number;
  cwd?: string;
  stateDir?: string;
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
  agents?: Record<string, string>;
};

export class AcpSessionManagerService {
  private sessions = new Map<string, ManagedAcpSession>();
  private runtime: AcpRuntime | null = null;
  private eventCallbacks: ServiceEventCallback[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private maxSessions = 50;
  private sessionTtlMs = 24 * 60 * 60 * 1000;
  private approvalTimeoutMs = 5 * 60 * 1000;
  private runtimeConfig: AcpSessionManagerConfig = {};

  configure(config: AcpSessionManagerConfig | undefined | null): void {
    if (!config) return;
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

  /** 直接使用 acpx createAcpRuntime 初始化，带 onPermissionRequest */
  start(): void {
    if (this.started) return;

    const cwd = this.runtimeConfig.cwd || process.cwd();
    const stateDir = this.runtimeConfig.stateDir || `${cwd}/.acp-sessions`;

    const options: AcpRuntimeOptions = {
      cwd,
      sessionStore: createFileSessionStore({ stateDir }),
      agentRegistry: createAgentRegistry({ overrides: this.runtimeConfig.agents }),
      permissionMode: this.runtimeConfig.permissionMode || "approve-reads",
      nonInteractivePermissions: "deny",
      onPermissionRequest: async (req, ctx) => {
        return this.handlePermissionRequest(req, ctx);
      },
    };

    this.runtime = createAcpRuntime(options);

    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60_000);
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const activeSessions = [...this.sessions.values()].filter(
      (s) => s.status === "running",
    );
    await Promise.allSettled(
      activeSessions.map((s) => this.closeSession(s.sessionId, "service_shutdown")),
    );
    this.sessions.clear();
    this.started = false;
  }

  onEvent(callback: ServiceEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  async launchSession(params: AcpSessionLaunchParams): Promise<ManagedAcpSession> {
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
      pendingApprovals: [],
      parentSessionKey: params.parentSessionKey,
    };

    this.sessions.set(sessionId, session);
    this.emitEvent({ type: "session_created", sessionId, agentId: params.agentId });

    await this.executeTurn(sessionId, params.task);
    return this.sessions.get(sessionId) ?? session;
  }

  async sendMessage(sessionId: string, message: string): Promise<TurnResult> {
    const session = this.getSessionOrThrow(sessionId);
    if (session.status !== "running") {
      throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
    }
    return this.executeTurn(sessionId, message);
  }

  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");
    await this.runtime.cancel({ handle: session.handle, reason });
    session.status = "cancelled";
    session.lastActiveAt = Date.now();
    this.emitEvent({ type: "session_cancelled", sessionId });
  }

  async closeSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");
    try {
      await this.runtime.close({ handle: session.handle, reason: reason || "user_requested" });
    } catch { /* ignore */ }
    session.status = "completed";
    session.lastActiveAt = Date.now();
    this.sessions.delete(sessionId);
  }

  async setConfig(sessionId: string, key: string, value: string): Promise<void> {
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
    return sessions;
  }

  getSession(sessionId: string): ManagedAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  addPendingApproval(approval: PendingApproval): void {
    const session = this.sessions.get(approval.sessionId);
    if (session) {
      session.pendingApprovals.push(approval);
      session.lastActiveAt = Date.now();
      this.emitEvent({ type: "approval_requested", sessionId: approval.sessionId, approval });
    }
  }

  resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const idx = session.pendingApprovals.findIndex((a) => a.approvalId === approvalId);
    if (idx === -1) return false;
    const approval = session.pendingApprovals[idx]!;
    if (approval.resolve) approval.resolve(decision);
    session.pendingApprovals.splice(idx, 1);
    session.lastActiveAt = Date.now();
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
    const sessionId = this.findSessionIdByAcpSessionId(req.sessionId);
    if (!sessionId) return undefined;

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

    return new Promise<AcpPermissionDecision | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      approval.resolve = (decision: ApprovalDecision) => {
        if (timer) clearTimeout(timer);
        resolve(this.mapDecisionToAcpDecision(decision));
      };

      this.addPendingApproval(approval);

      timer = setTimeout(() => {
        this.resolveApproval(sessionId, approvalId, "reject");
        resolve({ outcome: "reject_once" });
      }, this.approvalTimeoutMs);

      ctx.signal.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
        this.resolveApproval(sessionId, approvalId, "cancel");
        resolve({ outcome: "cancel" });
      }, { once: true });
    });
  }

  private findSessionIdByAcpSessionId(acpSessionId: string): string | undefined {
    for (const [id, session] of this.sessions) {
      const handleSessionId = session.handle.agentSessionId || session.handle.backendSessionId;
      if (handleSessionId === acpSessionId) return id;
      if (session.handle.sessionKey.includes(id)) return id;
    }
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

  private async executeTurn(sessionId: string, text: string): Promise<TurnResult> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");

    const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const turn = this.runtime.startTurn({
        handle: session.handle,
        text,
        mode: "prompt",
        requestId,
      });

      for await (const event of turn.events) {
        switch (event.type) {
          case "text_delta":
            session.output += event.text;
            break;
          case "tool_call":
            session.toolCalls.push({
              toolCallId: event.toolCallId || requestId,
              toolName: event.text,
              title: event.title,
              status: event.status,
              timestamp: Date.now(),
            });
            break;
          default:
            break;
        }
      }

      const result = await turn.result;
      session.lastActiveAt = Date.now();

      if (result.status === "completed") {
        session.lastStopReason = result.stopReason;
        session.status = session.mode === "session" ? "running" : "completed";
        this.emitEvent({ type: "session_completed", sessionId, output: session.output });
        return { status: "completed", output: session.output, stopReason: result.stopReason };
      } else if (result.status === "failed") {
        session.status = "failed";
        session.error = result.error.message;
        this.emitEvent({ type: "session_failed", sessionId, error: result.error.message });
        return { status: "failed", error: result.error.message };
      } else {
        session.status = "cancelled";
        this.emitEvent({ type: "session_cancelled", sessionId });
        return { status: "cancelled" };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      session.status = "failed";
      session.error = errorMsg;
      session.lastActiveAt = Date.now();
      this.emitEvent({ type: "session_failed", sessionId, error: errorMsg });
      return { status: "failed", error: errorMsg };
    }
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
    for (const cb of this.eventCallbacks) {
      try { cb(event); } catch { /* swallow */ }
    }
  }
}

function generateSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
