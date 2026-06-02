/**
 * Event Injector Hook
 *
 * 监听 Service 层事件，将子 ACP Session 的关键事件（完成、失败等）
 * 注入到主 Session 的下一轮上下文中，必要时唤醒主 Session 处理。
 */

import { getService } from "../shared.js";
import {
  formatSessionCompletionNotice,
  formatSessionFailureNotice,
} from "../utils/event-formatter.js";
import type { SessionEvent } from "../types.js";

/**
 * 注册事件注入 Hook
 *
 * 监听 Service 层的所有事件，将关键事件注入到主 Session。
 */
export function registerEventInjector(api: any): void {
  const service = getService();

  service.onEvent(async (event: SessionEvent) => {
    switch (event.type) {
      case "session_completed":
        await injectSessionCompletedEvent(api, event.sessionId, event.output);
        break;
      case "session_failed":
        await injectSessionFailedEvent(api, event.sessionId, event.error);
        break;
      default:
        break;
    }
  });
}

/** 注入会话完成事件 */
async function injectSessionCompletedEvent(
  api: any,
  sessionId: string,
  output: string,
): Promise<void> {
  const session = getService().getSession(sessionId);
  const parentSessionKey = session?.parentSessionKey;
  if (!parentSessionKey) {
    // 没有记录父 Session（极少数边界情况，如非工具触发的内部调用）
    // 没有注入目标，直接跳过——而不是把通知发到错误的 session
    // eslint-disable-next-line no-console
    console.warn(
      `[event-injector] Skipping completion injection for ${sessionId}: parentSessionKey not recorded`,
    );
    return;
  }

  // 优先使用统一的 formatter；session 不存在时回退到简单文本（防御性处理）
  const text = session
    ? formatSessionCompletionNotice(session, output)
    : `## ACP 子会话完成通知\n\n- **会话 ID**: ${sessionId}\n- **状态**: 已完成\n\n**输出**:\n\`\`\`\n${
        output.length > 1000 ? output.slice(-1000) + "\n...(truncated)" : output
      }\n\`\`\``;

  try {
    await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: parentSessionKey,
      text,
      placement: "append_context",
      ttlMs: 600_000, // 10 minutes
      idempotencyKey: `completed:${sessionId}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[event-injector] Failed to inject completion event: ${String(err)}`,
    );
  }
}

/** 注入会话失败事件 */
async function injectSessionFailedEvent(
  api: any,
  sessionId: string,
  error: string,
): Promise<void> {
  const session = getService().getSession(sessionId);
  const parentSessionKey = session?.parentSessionKey;
  if (!parentSessionKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[event-injector] Skipping failure injection for ${sessionId}: parentSessionKey not recorded`,
    );
    return;
  }

  // 优先使用统一的 formatter；session 不存在时回退到简单文本（防御性处理）
  const text = session
    ? formatSessionFailureNotice(session, error)
    : `## ACP 子会话失败通知\n\n- **会话 ID**: ${sessionId}\n- **状态**: 失败\n- **错误**: ${error}\n\n请使用 \`acp_send\` 重试或 \`acp_close\` 关闭会话。`;

  try {
    await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: parentSessionKey,
      text,
      placement: "prepend_context",
      ttlMs: 600_000,
      idempotencyKey: `failed:${sessionId}`,
    });

    // 唤醒父 Session 处理失败事件
    await api.session.workflow.scheduleSessionTurn({
      sessionKey: parentSessionKey,
      message: `[ACP Session Manager] 子会话 ${sessionId} 执行失败，需要处理`,
      delayMs: 0,
      deleteAfterRun: true,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[event-injector] Failed to inject failure event: ${String(err)}`,
    );
  }
}
