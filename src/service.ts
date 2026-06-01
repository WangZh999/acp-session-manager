/**
 * ACP Session Manager Service
 *
 * 核心服务层：会话池管理、ACP Runtime 调用、审批队列。
 */

import type {
  ManagedAcpSession,
  AcpSessionLaunchParams,
  AcpSessionStatus,
  PendingApproval,
  ApprovalDecision,
  TurnResult,
  SessionEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurn,
  AcpRuntimeEvent,
} from "./types.js";

/**
 * 简化的 ACP Runtime 接口（适配 openclaw 的 AcpRuntime）
 *
 * 注意：mode 用 string 以兼容 "turn" 等本地语义，实际调用前会按需转换。
 */
export type AcpRuntime = {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    resumeSessionId?: string;
    model?: string;
    thinking?: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<AcpRuntimeHandle>;
  startTurn?(input: {
    handle: AcpRuntimeHandle;
    text: string;
    mode: string;
    requestId: string;
    signal?: AbortSignal;
  }): AcpRuntimeTurn;
  runTurn(input: {
    handle: AcpRuntimeHandle;
    text: string;
    mode: string;
    requestId: string;
    signal?: AbortSignal;
  }): AsyncIterable<AcpRuntimeEvent>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void>;
  setMode?(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
  setConfigOption?(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void>;
};

/** 通过 ID 获取 ACP Runtime backend */
export type RequireRuntimeBackend = (id: string) => { runtime: AcpRuntime };

/** 事件回调 - 用于通知 Plugin 层 */
export type ServiceEventCallback = (event: SessionEvent) => void;

/** 运行时可调配置（来源：openclaw.plugin.json 中的 configSchema） */
export type AcpSessionManagerConfig = {
  /** 最大并发管理的子会话数 */
  maxSessions?: number;
  /** 会话 TTL（小时），超过未活跃则自动清理 */
  sessionTtlHours?: number;
  /** 审批请求默认超时（毫秒），到时间自动 reject */
  approvalTimeoutMs?: number;
};

export class AcpSessionManagerService {
  private sessions = new Map<string, ManagedAcpSession>();
  private runtime: AcpRuntime | null = null;
  private eventCallbacks: ServiceEventCallback[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private requireRuntimeBackendFn: RequireRuntimeBackend | null = null;
  private started = false;

  // 运行时配置（可由 configure() 覆盖；默认值与 openclaw.plugin.json 保持一致）
  private maxSessions = 50;
  private sessionTtlMs = 24 * 60 * 60 * 1000; // 24h
  private approvalTimeoutMs = 5 * 60 * 1000; // 5min

  /** 应用 Plugin 配置（在 register/start 阶段由 index.ts 调用） */
  configure(config: AcpSessionManagerConfig | undefined | null): void {
    if (!config) return;
    if (typeof config.maxSessions === "number" && config.maxSessions > 0) {
      this.maxSessions = Math.floor(config.maxSessions);
    }
    if (typeof config.sessionTtlHours === "number" && config.sessionTtlHours > 0) {
      this.sessionTtlMs = Math.floor(config.sessionTtlHours * 60 * 60 * 1000);
    }
    if (
      typeof config.approvalTimeoutMs === "number" &&
      config.approvalTimeoutMs >= 10_000
    ) {
      this.approvalTimeoutMs = Math.floor(config.approvalTimeoutMs);
    }
  }

  /** 当前生效的审批超时（毫秒） */
  getApprovalTimeoutMs(): number {
    return this.approvalTimeoutMs;
  }

  /** 初始化服务（不立即获取 Runtime，等首次工具调用时懒加载） */
  start(requireRuntimeBackend: RequireRuntimeBackend): void {
    this.requireRuntimeBackendFn = requireRuntimeBackend;
    // 不在此处调用 ensureStarted() — acpx backend 可能尚未注册
    // 改为首次工具调用时懒初始化
  }

  /** 设置延迟初始化的 runtime backend resolver */
  setRuntimeBackendResolver(fn: RequireRuntimeBackend): void {
    this.requireRuntimeBackendFn = fn;
  }

  /** 确保 runtime 已初始化（支持懒加载） */
  private ensureStarted(): void {
    if (this.started) return;
    if (!this.requireRuntimeBackendFn) {
      throw new Error("Service not started: no runtime backend resolver configured");
    }
    // eslint-disable-next-line no-console
    console.log("[acp-session-manager] ensureStarted: resolving acpx backend...");
    try {
      const backend = this.requireRuntimeBackendFn("acpx");
      // eslint-disable-next-line no-console
      console.log("[acp-session-manager] ensureStarted: got backend", !!backend, "runtime:", !!backend?.runtime);
      this.runtime = backend.runtime;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[acp-session-manager] ensureStarted: requireBackend failed:", err instanceof Error ? err.message : err);
      throw err;
    }
    // 启动定期清理
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60_000);
    }
    this.started = true;
    // eslint-disable-next-line no-console
    console.log("[acp-session-manager] ensureStarted: service initialized successfully");
  }

  /** 停止服务，清理所有会话 */
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
  }

  /** 注册事件回调 */
  onEvent(callback: ServiceEventCallback): void {
    this.eventCallbacks.push(callback);
  }

  /** 拉起新的 ACP 会话 */
  async launchSession(params: AcpSessionLaunchParams): Promise<ManagedAcpSession> {
    this.ensureStarted();
    // ensureStarted() guarantees runtime is set; this assertion guards against future refactors
    if (!this.runtime) throw new Error("Service not started: runtime unavailable after ensureStarted()");
    if (!params.agentId || typeof params.agentId !== "string" || !params.agentId.trim()) {
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
    const runtimeMode: "persistent" | "oneshot" =
      params.mode === "session" ? "persistent" : "oneshot";

    const ensureInput: {
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      model?: string;
      thinking?: string;
      cwd?: string;
    } = {
      sessionKey,
      agent: params.agentId,
      mode: runtimeMode,
    };
    // 仅传递已定义的可选参数，避免 undefined 导致 runtime 内部 .trim() 报错
    if (params.model) ensureInput.model = params.model;
    if (params.thinking) ensureInput.thinking = params.thinking;
    if (params.cwd) ensureInput.cwd = params.cwd;

    const handle = await this.runtime.ensureSession(ensureInput);

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

    // 执行首轮对话
    await this.executeTurn(sessionId, params.task);
    return this.sessions.get(sessionId) ?? session;
  }

  /** 向会话发送消息（多轮对话/介入） */
  async sendMessage(sessionId: string, message: string): Promise<TurnResult> {
    const session = this.getSessionOrThrow(sessionId);
    if (session.status !== "running") {
      throw new Error(
        `Session ${sessionId} is not active (status: ${session.status})`,
      );
    }
    return this.executeTurn(sessionId, message);
  }

  /** 取消会话执行 */
  async cancelSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");
    await this.runtime.cancel({ handle: session.handle, reason });
    session.status = "cancelled";
    session.lastActiveAt = Date.now();
    this.emitEvent({ type: "session_cancelled", sessionId });
  }

  /** 关闭会话并清理 */
  async closeSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");
    try {
      await this.runtime.close({
        handle: session.handle,
        reason: reason || "user_requested",
      });
    } catch {
      /* ignore close errors */
    }
    session.status = "completed";
    session.lastActiveAt = Date.now();
    this.sessions.delete(sessionId);
  }

  /** 修改会话配置 */
  async setConfig(sessionId: string, key: string, value: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime?.setConfigOption) {
      throw new Error("Runtime does not support setConfigOption");
    }
    await this.runtime.setConfigOption({ handle: session.handle, key, value });
    session.lastActiveAt = Date.now();
    if (key === "model") session.model = value;
  }

  /** 获取会话列表 */
  listSessions(filter?: { status?: AcpSessionStatus }): ManagedAcpSession[] {
    let sessions = [...this.sessions.values()];
    if (filter?.status) {
      sessions = sessions.filter((s) => s.status === filter.status);
    }
    return sessions;
  }

  /** 获取单个会话 */
  getSession(sessionId: string): ManagedAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 添加审批请求到队列 */
  addPendingApproval(approval: PendingApproval): void {
    const session = this.sessions.get(approval.sessionId);
    if (session) {
      session.pendingApprovals.push(approval);
      session.lastActiveAt = Date.now();
      this.emitEvent({
        type: "approval_requested",
        sessionId: approval.sessionId,
        approval,
      });
    }
  }

  /** 处理审批决策 */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const approvalIndex = session.pendingApprovals.findIndex(
      (a) => a.approvalId === approvalId,
    );
    if (approvalIndex === -1) return false;
    const approval = session.pendingApprovals[approvalIndex]!;
    if (approval.resolve) {
      approval.resolve(decision);
    }
    session.pendingApprovals.splice(approvalIndex, 1);
    session.lastActiveAt = Date.now();
    this.emitEvent({ type: "approval_resolved", sessionId, approvalId, decision });
    return true;
  }

  /** 获取所有待处理审批 */
  getPendingApprovals(): PendingApproval[] {
    const allApprovals: PendingApproval[] = [];
    for (const session of this.sessions.values()) {
      allApprovals.push(...session.pendingApprovals);
    }
    return allApprovals;
  }

  // ========== Private Methods ==========

  private async executeTurn(sessionId: string, text: string): Promise<TurnResult> {
    const session = this.getSessionOrThrow(sessionId);
    if (!this.runtime) throw new Error("Service not started");

    const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      let turnEvents: AsyncIterable<AcpRuntimeEvent>;

      if (this.runtime.startTurn) {
        const turn = this.runtime.startTurn({
          handle: session.handle,
          text,
          mode: "turn",
          requestId,
        });
        turnEvents = turn.events;
      } else {
        turnEvents = this.runtime.runTurn({
          handle: session.handle,
          text,
          mode: "turn",
          requestId,
        });
      }

      for await (const event of turnEvents) {
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
          case "done":
            session.lastStopReason = event.stopReason;
            session.lastActiveAt = Date.now();
            if (session.mode === "session") {
              // 持久会话：turn 结束后保持 running，支持后续 acp_send
              session.status = "running";
            } else {
              // 一次性会话：turn 结束即完成
              session.status = "completed";
            }
            this.emitEvent({
              type: "session_completed",
              sessionId,
              output: session.output,
            });
            return {
              status: "completed",
              output: session.output,
              stopReason: event.stopReason,
            };
          case "error":
            session.status = "failed";
            session.error = event.message;
            session.lastActiveAt = Date.now();
            this.emitEvent({
              type: "session_failed",
              sessionId,
              error: event.message,
            });
            return { status: "failed", error: event.message };
          // status 事件不影响返回
          default:
            break;
        }
      }

      // 事件流正常结束但没有 done/error
      session.lastActiveAt = Date.now();
      return { status: "completed", output: session.output };
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
        // 先关闭 Runtime 连接，再从 Map 移除
        if (this.runtime) {
          try {
            await this.runtime.close({ handle: session.handle, reason: "ttl_expired" });
          } catch {
            /* ignore close errors during cleanup */
          }
        }
        this.sessions.delete(id);
      }
    }
  }

  private emitEvent(event: SessionEvent): void {
    for (const cb of this.eventCallbacks) {
      try {
        cb(event);
      } catch {
        /* swallow callback errors */
      }
    }
  }
}

function generateSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
