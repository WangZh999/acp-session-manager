/**
 * Event Injector Hook
 *
 * 监听 Service 层事件，将子 ACP Session 的关键事件（完成、失败等）
 * 注入到主 Session 的下一轮上下文中，并唤醒主 Session 处理。
 */

import { getService } from "../shared.js";
import {
  formatSessionCompletionNotice,
  formatSessionFailureNotice,
} from "../utils/event-formatter.js";
import type { SessionEvent } from "../types.js";

export function registerEventInjector(api: any): void {
  const service = getService();

  console.log("[acp-sm] event-injector: registered, api.session =", typeof api?.session, "workflow =", typeof api?.session?.workflow);

  service.onEvent(async (event: SessionEvent) => {
    console.log("[acp-sm] event-injector: received event:", event.type);
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

async function injectSessionCompletedEvent(
  api: any,
  sessionId: string,
  output: string,
): Promise<void> {
  const session = getService().getSession(sessionId);
  const parentSessionKey = session?.parentSessionKey;
  console.log("[acp-sm] event-injector: injectCompleted sessionId=" + sessionId, "parentSessionKey=" + (parentSessionKey || "NONE"), "api.session.workflow=" + typeof api?.session?.workflow);
  if (!parentSessionKey) return;

  const text = session
    ? formatSessionCompletionNotice(session, output)
    : `## ACP 子会话完成\n\n- **Session**: ${sessionId}\n- **输出**: ${output.slice(-500)}`;

  try {
    await api.session?.workflow?.enqueueNextTurnInjection?.({
      sessionKey: parentSessionKey,
      text,
      placement: "append_context",
      ttlMs: 600_000,
      idempotencyKey: `completed:${sessionId}`,
    });

    await api.session?.workflow?.scheduleSessionTurn?.({
      sessionKey: parentSessionKey,
      message: `[ACP] 子会话 ${sessionId} (${session?.agentId || "agent"}) 已完成`,
      delayMs: 0,
      deleteAfterRun: true,
    });
  } catch (err) {
    console.error(`[acp-sm] event-injector: completion inject failed: ${String(err)}`);
  }
}

async function injectSessionFailedEvent(
  api: any,
  sessionId: string,
  error: string,
): Promise<void> {
  const session = getService().getSession(sessionId);
  const parentSessionKey = session?.parentSessionKey;
  if (!parentSessionKey) return;

  const text = session
    ? formatSessionFailureNotice(session, error)
    : `## ACP 子会话失败\n\n- **Session**: ${sessionId}\n- **错误**: ${error}`;

  try {
    await api.session?.workflow?.enqueueNextTurnInjection?.({
      sessionKey: parentSessionKey,
      text,
      placement: "prepend_context",
      ttlMs: 600_000,
      idempotencyKey: `failed:${sessionId}`,
    });

    await api.session?.workflow?.scheduleSessionTurn?.({
      sessionKey: parentSessionKey,
      message: `[ACP] 子会话 ${sessionId} (${session?.agentId || "agent"}) 执行失败: ${error.slice(0, 100)}`,
      delayMs: 0,
      deleteAfterRun: true,
    });
  } catch (err) {
    console.error(`[acp-sm] event-injector: failure inject failed: ${String(err)}`);
  }
}
