/**
 * Session Pool Utilities
 *
 * 会话池统计、摘要格式化与排序工具。
 */

import type { ManagedAcpSession, AcpSessionStatus } from "../types.js";

/**
 * 会话池统计信息
 */
export type SessionPoolStats = {
  total: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  pendingApprovals: number;
  oldestSessionAge: number; // ms
};

/**
 * 计算会话池统计信息
 */
export function computePoolStats(
  sessions: ManagedAcpSession[],
): SessionPoolStats {
  const now = Date.now();
  const stats: SessionPoolStats = {
    total: sessions.length,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pendingApprovals: 0,
    oldestSessionAge: 0,
  };

  for (const session of sessions) {
    switch (session.status) {
      case "running":
        stats.running++;
        break;
      case "completed":
        stats.completed++;
        break;
      case "failed":
        stats.failed++;
        break;
      case "cancelled":
        stats.cancelled++;
        break;
      default:
        break;
    }
    stats.pendingApprovals += session.pendingApprovals.length;
    const age = now - session.createdAt;
    if (age > stats.oldestSessionAge) stats.oldestSessionAge = age;
  }

  return stats;
}

/**
 * 格式化会话摘要（用于 tool 返回）
 */
export function formatSessionSummary(
  session: ManagedAcpSession,
): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    status: session.status,
    mode: session.mode,
    createdAt: new Date(session.createdAt).toISOString(),
    lastActiveAt: new Date(session.lastActiveAt).toISOString(),
    model: session.model || "default",
    outputLength: session.output.length,
    toolCallsCount: session.toolCalls.length,
    pendingApprovalsCount: session.pendingApprovals.length,
    error: session.error,
  };
}

/**
 * 会话排序：活跃在前、最近活跃在前
 */
export function sortSessionsByActivity(
  sessions: ManagedAcpSession[],
): ManagedAcpSession[] {
  const statusPriority: Record<AcpSessionStatus, number> = {
    running: 0,
    initializing: 1,
    completed: 2,
    failed: 3,
    cancelled: 4,
  };

  return [...sessions].sort((a, b) => {
    const priorityDiff = statusPriority[a.status] - statusPriority[b.status];
    if (priorityDiff !== 0) return priorityDiff;
    return b.lastActiveAt - a.lastActiveAt;
  });
}
