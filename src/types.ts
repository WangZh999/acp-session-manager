/**
 * ACP Session Manager - Core Types
 *
 * 使用 acpx/runtime 的标准类型，仅定义 Plugin 管理层的扩展类型。
 */

import type {
  AcpRuntimeHandle as _AcpRuntimeHandle,
  AcpRuntimeEvent as _AcpRuntimeEvent,
  AcpRuntimeTurnResult as _AcpRuntimeTurnResult,
  AcpRuntimeTurn as _AcpRuntimeTurn,
  AcpPermissionRequest as _AcpPermissionRequest,
  AcpPermissionDecision as _AcpPermissionDecision,
} from "acpx/runtime";

export type AcpRuntimeHandle = _AcpRuntimeHandle;
export type AcpRuntimeEvent = _AcpRuntimeEvent;
export type AcpRuntimeTurnResult = _AcpRuntimeTurnResult;
export type AcpRuntimeTurn = _AcpRuntimeTurn;
export type AcpPermissionRequest = _AcpPermissionRequest;
export type AcpPermissionDecision = _AcpPermissionDecision;

// ============================================================
// Managed Session Types
// ============================================================

/** 会话状态枚举 */
export type AcpSessionStatus =
  | "initializing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** 管理的 ACP 会话记录 */
export type ManagedAcpSession = {
  /** 唯一会话 ID */
  sessionId: string;
  /** ACP Runtime Handle */
  handle: AcpRuntimeHandle;
  /** 目标 Agent ID (codex/claude/gemini 等) */
  agentId: string;
  /** 会话状态 */
  status: AcpSessionStatus;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 会话模式 */
  mode: "run" | "session";
  /** 工作目录 */
  cwd?: string;
  /** 模型覆盖 */
  model?: string;
  /** 累积输出文本 */
  output: string;
  /** 工具调用记录 */
  toolCalls: ToolCallRecord[];
  /** 待处理审批请求队列 */
  pendingApprovals: PendingApproval[];
  /** 错误信息 */
  error?: string;
  /** 最后 turn 的停止原因 */
  lastStopReason?: string;
  /**
   * 拉起此子会话的父 Session key（即调用 acp_launch 工具的那个 Session）。
   * 用于将子会话的审批/完成/失败事件注入回正确的主会话上下文。
   */
  parentSessionKey?: string;
};

/** 工具调用记录 */
export type ToolCallRecord = {
  toolCallId: string;
  toolName: string;
  title?: string;
  status?: string;
  timestamp: number;
};

// ============================================================
// Launch Params
// ============================================================

/** 拉起 ACP 会话参数 */
export type AcpSessionLaunchParams = {
  /** 目标 Agent ID */
  agentId: string;
  /** 初始任务/Prompt */
  task: string;
  /** 会话模式: run=一次性, session=可恢复 */
  mode?: "run" | "session";
  /** 模型覆盖 */
  model?: string;
  /** 工作目录 */
  cwd?: string;
  /** 推理强度 */
  thinking?: string;
  /** 拉起此会话的父 Session key（由 acp_launch 工具从调用上下文捕获） */
  parentSessionKey?: string;
};

// ============================================================
// Approval Types
// ============================================================

/** 待处理审批请求 */
export type PendingApproval = {
  /** 唯一审批 ID */
  approvalId: string;
  /** 关联的会话 ID */
  sessionId: string;
  /** 工具名称 */
  toolName?: string;
  /** 操作标题 */
  title: string;
  /** 操作描述/详情 */
  description?: string;
  /** 可选的决策选项 */
  options: ApprovalOption[];
  /** 请求时间戳 */
  timestamp: number;
  /** 超时时间 (ms) */
  timeoutMs: number;
  /** 决策 Promise 的 resolver */
  resolve?: (decision: ApprovalDecision) => void;
};

/** 审批选项 */
export type ApprovalOption = {
  id: string;
  label: string;
  description?: string;
};

/** 审批决策 */
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "reject"
  | "cancel";

// ============================================================
// Turn Result
// ============================================================

/** Turn 执行结果（工具返回值） */
export type TurnResult = {
  status: "completed" | "cancelled" | "failed" | "pending_approval";
  output?: string;
  stopReason?: string;
  error?: string;
  pendingApprovalId?: string;
};

// ============================================================
// Service Events
// ============================================================

/** 会话事件类型 */
export type SessionEvent =
  | { type: "session_created"; sessionId: string; agentId: string }
  | { type: "session_completed"; sessionId: string; output: string }
  | { type: "session_failed"; sessionId: string; error: string }
  | { type: "session_cancelled"; sessionId: string }
  | { type: "approval_requested"; sessionId: string; approval: PendingApproval }
  | { type: "approval_resolved"; sessionId: string; approvalId: string; decision: ApprovalDecision };
