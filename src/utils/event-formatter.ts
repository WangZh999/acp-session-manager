/**
 * Event Formatter Utilities
 *
 * 用于将审批、会话完成/失败、Turn 结果等事件格式化为可读文本或结构化 JSON。
 */

import type {
  PendingApproval,
  ManagedAcpSession,
  TurnResult,
} from "../types.js";

/**
 * 格式化审批消息（用于主 Session 注入）
 */
export function formatApprovalForInjection(
  sessionId: string,
  approval: PendingApproval,
): string {
  const lines = [
    `## 🔐 ACP 审批请求`,
    ``,
    `| 字段 | 值 |`,
    `|------|------|`,
    `| 会话 ID | \`${sessionId}\` |`,
    `| 审批 ID | \`${approval.approvalId}\` |`,
    `| 操作 | ${approval.title} |`,
  ];

  if (approval.toolName) {
    lines.push(`| 工具 | \`${approval.toolName}\` |`);
  }

  if (approval.description) {
    lines.push(``, `**详情**: ${approval.description}`);
  }

  lines.push(``);
  lines.push(`**可选决策**:`);
  for (const opt of approval.options) {
    lines.push(
      `- \`${opt.id}\` — ${opt.label}${opt.description ? `: ${opt.description}` : ""}`,
    );
  }

  lines.push(``);
  lines.push(
    `> 使用 \`acp_approve(session_id="${sessionId}", approval_id="${approval.approvalId}", decision="...")\` 处理`,
  );

  return lines.join("\n");
}

/**
 * 格式化会话完成通知
 */
export function formatSessionCompletionNotice(
  session: ManagedAcpSession,
  output: string,
): string {
  const truncatedOutput =
    output.length > 800
      ? output.slice(0, 400) +
        "\n\n...(truncated)...\n\n" +
        output.slice(-400)
      : output;

  return [
    `## ✅ ACP 子会话完成`,
    ``,
    `- **Session**: \`${session.sessionId}\` (${session.agentId})`,
    `- **耗时**: ${formatDuration(Date.now() - session.createdAt)}`,
    `- **工具调用**: ${session.toolCalls.length} 次`,
    ``,
    `**输出**:`,
    "```",
    truncatedOutput,
    "```",
  ].join("\n");
}

/**
 * 格式化会话失败通知
 */
export function formatSessionFailureNotice(
  session: ManagedAcpSession,
  error: string,
): string {
  return [
    `## ❌ ACP 子会话失败`,
    ``,
    `- **Session**: \`${session.sessionId}\` (${session.agentId})`,
    `- **错误**: ${error}`,
    ``,
    `**建议操作**:`,
    `- \`acp_send(session_id="${session.sessionId}", message="retry")\` 重试`,
    `- \`acp_close(session_id="${session.sessionId}")\` 关闭`,
  ].join("\n");
}

/**
 * 格式化 Turn 结果（用于 tool 返回值）
 */
export function formatTurnResult(
  result: TurnResult,
  output?: string,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    status: result.status,
  };

  if (result.output || output) {
    const text = result.output || output || "";
    formatted.output = text.length > 2000 ? text.slice(-2000) : text;
  }

  if (result.stopReason) formatted.stopReason = result.stopReason;
  if (result.error) formatted.error = result.error;
  if (result.pendingApprovalId)
    formatted.pendingApprovalId = result.pendingApprovalId;

  return formatted;
}

/**
 * 格式化时间间隔
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000)
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
