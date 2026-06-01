/**
 * ACP Session Manager Plugin - Entry Point
 *
 * 直接集成 acpx runtime，无需通过 openclaw/plugin-sdk/acp-runtime-backend。
 * 通过 onPermissionRequest 回调实现审批拦截。
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getService, getPluginApi, setPluginApi } from "./shared.js";
import {
  createAcpLaunchTool,
  createAcpListTool,
  createAcpSendTool,
  createAcpCancelTool,
  createAcpConfigTool,
  createAcpCloseTool,
  createAcpApproveTool,
} from "./tools/index.js";
import { registerApprovalCaptureHook } from "./hooks/approval-capture.js";
import { registerEventInjector } from "./hooks/event-injector.js";
import { formatApprovalForInjection } from "./utils/event-formatter.js";
import type { SessionEvent, PendingApproval } from "./types.js";

export { getService, getPluginApi };

export default definePluginEntry({
  id: "acp-session-manager",
  name: "ACP Session Manager",
  description:
    "Manage ACP sub-sessions lifecycle, mid-turn intervention, and approval surfacing via direct acpx integration.",

  register(api: any) {
    setPluginApi(api);
    const service = getService();

    const apiAny = api as any;
    const pluginConfig =
      apiAny?.config ??
      (typeof apiAny?.getConfig === "function" ? apiAny.getConfig() : undefined) ??
      apiAny?.plugin?.config ??
      undefined;
    service.configure(pluginConfig);

    api.registerService({
      id: "acp-session-manager-service",
      start: async () => {
        service.start();

        service.onEvent((event: SessionEvent) => {
          if (event.type === "approval_requested") {
            void handleApprovalSurfacing(api, event.sessionId, event.approval);
          }
        });
      },
      stop: async () => {
        await service.stop();
      },
    });

    api.registerTool((ctx: any) => createAcpLaunchTool(ctx), { names: ["acp_launch"] });
    api.registerTool((ctx: any) => createAcpListTool(ctx), { names: ["acp_list"] });
    api.registerTool((ctx: any) => createAcpSendTool(ctx), { names: ["acp_send"] });
    api.registerTool((ctx: any) => createAcpCancelTool(ctx), { names: ["acp_cancel"] });
    api.registerTool((ctx: any) => createAcpConfigTool(ctx), { names: ["acp_config"] });
    api.registerTool((ctx: any) => createAcpCloseTool(ctx), { names: ["acp_close"] });
    api.registerTool((ctx: any) => createAcpApproveTool(ctx), { names: ["acp_approve"] });

    registerApprovalCaptureHook(api);
    registerEventInjector(api);
  },
});

async function handleApprovalSurfacing(
  api: any,
  sessionId: string,
  approval: PendingApproval,
): Promise<void> {
  const session = getService().getSession(sessionId);
  const parentSessionKey = session?.parentSessionKey;
  if (!parentSessionKey) return;

  try {
    const approvalText = formatApprovalForInjection(sessionId, approval);

    await api.session?.workflow?.enqueueNextTurnInjection?.({
      sessionKey: parentSessionKey,
      text: approvalText,
      placement: "prepend_context",
      ttlMs: approval.timeoutMs || 300_000,
      idempotencyKey: `approval:${approval.approvalId}`,
    });

    await api.session?.workflow?.scheduleSessionTurn?.({
      sessionKey: parentSessionKey,
      message: `[ACP Session Manager] 子会话 ${sessionId} 有待处理的审批请求`,
      delayMs: 0,
      deleteAfterRun: true,
    });
  } catch (err) {
    console.error(`[acp-session-manager] Failed to surface approval: ${String(err)}`);
  }
}
