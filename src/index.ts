/**
 * ACP Session Manager Plugin
 *
 * 在 OpenClaw 中管理 ACP 子会话的生命周期、介入和审批透出。
 *
 * 注册模式（Plugin SDK 标准）：
 *   - 入口使用 `definePluginEntry()` 包装
 *   - 工具通过 `api.registerTool((ctx) => createXxxTool(ctx), { names: [...] })` 注册
 *     每个 factory 返回符合 `AnyAgentTool` 的对象（含 label、AgentToolResult 返回格式）
 *
 * 参考：openclaw/extensions/tavily/index.ts、openclaw/extensions/memory-core/index.ts
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { requireAcpRuntimeBackend } from "openclaw/plugin-sdk/acp-runtime-backend";
import { type AcpRuntime } from "./service.js";
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

// 重新导出供外部消费者使用
export { getService, getPluginApi };

export default definePluginEntry({
  id: "acp-session-manager",
  name: "ACP Session Manager",
  description:
    "Manage ACP sub-sessions lifecycle, mid-turn intervention, and approval surfacing.",

  register(api) {
    setPluginApi(api);
    const service = getService();

    // 应用 Plugin 配置（来自 openclaw.plugin.json 的 configSchema）
    // 优先 api.config，再回退到旧版宿主可能暴露的 getConfig() / plugin.config。
    const apiAny = api as any;
    const pluginConfig =
      apiAny?.config ??
      (typeof apiAny?.getConfig === "function" ? apiAny.getConfig() : undefined) ??
      apiAny?.plugin?.config ??
      undefined;
    service.configure(pluginConfig);

    // runtime backend resolver（支持工具调用时懒初始化）
    try {
      const requireBackend = (id: string) => {
        const backend = requireAcpRuntimeBackend(id);
        return { runtime: backend.runtime as unknown as AcpRuntime };
      };
      service.setRuntimeBackendResolver(requireBackend);
    } catch {
      // requireAcpRuntimeBackend 在 register 阶段可能不可用，忽略
    }

    // 1. 注册 Service（管理生命周期）
    api.registerService({
      id: "acp-session-manager-service",
      start: async () => {
        const requireBackend = (id: string) => {
          const backend = requireAcpRuntimeBackend(id);
          return { runtime: backend.runtime as unknown as AcpRuntime };
        };
        service.start(requireBackend);

        // 审批事件回调 → 注入到拉起此子会话的父 Session
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

    // 2. 注册所有 Tools（factory 模式，由 SDK 在工具解析时注入 ctx）
    api.registerTool((ctx: any) => createAcpLaunchTool(ctx), { names: ["acp_launch"] });
    api.registerTool((ctx: any) => createAcpListTool(ctx), { names: ["acp_list"] });
    api.registerTool((ctx: any) => createAcpSendTool(ctx), { names: ["acp_send"] });
    api.registerTool((ctx: any) => createAcpCancelTool(ctx), { names: ["acp_cancel"] });
    api.registerTool((ctx: any) => createAcpConfigTool(ctx), { names: ["acp_config"] });
    api.registerTool((ctx: any) => createAcpCloseTool(ctx), { names: ["acp_close"] });
    api.registerTool((ctx: any) => createAcpApproveTool(ctx), { names: ["acp_approve"] });

    // 3. 注册 Hooks
    //    - approval-capture：从 Gateway 捕获子会话权限请求
    //    - event-injector：将子会话完成/失败事件注入主 Session
    registerApprovalCaptureHook(api);
    registerEventInjector(api);
  },
});

/**
 * 审批透出：将子 Session 的审批请求注入到拉起它的父 Session
 */
async function handleApprovalSurfacing(
  api: any,
  sessionId: string,
  approval: PendingApproval,
): Promise<void> {
  const session = getService().getSession(sessionId);
  const parentSessionKey = session?.parentSessionKey;
  if (!parentSessionKey) {
    // 没记录父 Session 时无法回注审批。直接超时让 approval-capture 自动 reject，
    // 比注入到错误的 Session 更安全。
    // eslint-disable-next-line no-console
    console.warn(
      `[acp-session-manager] Skipping approval surfacing for ${sessionId}: parentSessionKey not recorded; approval will time out`,
    );
    return;
  }

  try {
    const approvalText = formatApprovalMessage(sessionId, approval);

    // 注入到父 Session 的下一轮上下文
    await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: parentSessionKey,
      text: approvalText,
      placement: "prepend_context",
      ttlMs: approval.timeoutMs || 300_000,
      idempotencyKey: `approval:${approval.approvalId}`,
    });

    // 立即唤醒父 Session 处理审批
    await api.session.workflow.scheduleSessionTurn({
      sessionKey: parentSessionKey,
      message: `[ACP Session Manager] 子会话 ${sessionId} 有待处理的审批请求`,
      delayMs: 0,
      deleteAfterRun: true,
    });
  } catch (err) {
    // 审批透出失败不应阻塞主流程
    // eslint-disable-next-line no-console
    console.error(`[acp-session-manager] Failed to surface approval: ${String(err)}`);
  }
}

/**
 * 格式化审批消息
 *
 * 委托给 utils/event-formatter 统一格式化逻辑，避免重复实现。
 */
function formatApprovalMessage(sessionId: string, approval: PendingApproval): string {
  return formatApprovalForInjection(sessionId, approval);
}
