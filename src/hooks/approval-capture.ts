/**
 * Approval Capture Hook
 *
 * 从 Gateway 侧捕获子 ACP Session 的权限请求事件，转化为 Service 层的
 * PendingApproval，并通过 Promise 等待主 Session 经由 acp_approve 工具
 * 决策后回传到 Gateway。
 */

import { getService } from "../shared.js";
import type {
  PendingApproval,
  ApprovalDecision,
  ApprovalOption,
} from "../types.js";

/**
 * 注册审批事件捕获 Hook
 *
 * 监听来自子 ACP Session 的权限请求事件（exec.approval.requested），
 * 将其转换为 PendingApproval 并加入 Service 队列。
 */
export function registerApprovalCaptureHook(api: any): void {
  // 方式1: 通过 registerGatewayMethod 注册审批拦截
  api.registerGatewayMethod(
    "acp-session-manager.approval.intercept",
    async (options: any) => {
      const { params, respond } = options;

      const service = getService();
      const sessionId = resolveSessionId(params);
      if (!sessionId) {
        // 不是我们管理的会话，跳过
        respond(false, { handled: false });
        return;
      }

      // 创建 PendingApproval（默认超时来自 Plugin 配置）
      const approval = buildPendingApproval(
        params,
        sessionId,
        service.getApprovalTimeoutMs(),
      );

      // 等待决策（通过 Promise 阻塞直到 acp_approve 工具被调用）
      // 使用 Promise.race 实现超时保护；无论哪边先 resolve，都清理 timer
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const decision = await Promise.race<ApprovalDecision>([
          new Promise<ApprovalDecision>((resolve) => {
            approval.resolve = resolve;
            service.addPendingApproval(approval);
          }),
          new Promise<ApprovalDecision>((resolve) => {
            timer = setTimeout(() => {
              // 超时自动 reject，并从队列中移除
              service.resolveApproval(sessionId, approval.approvalId, "reject");
              resolve("reject");
            }, approval.timeoutMs);
          }),
        ]);

        // 回传决策
        respond(true, { decision: mapDecisionToGateway(decision) });
      } finally {
        // 决策先到的情况下，避免超时回调继续触发一次无效的 resolveApproval
        if (timer) clearTimeout(timer);
      }
    },
  );

  // 方式2: 通过 Hook 监听（如果 Plugin API 支持）
  // api.registerHook("exec.approval.requested", async (event) => { ... });
}

/** 从 Gateway 参数中解析会话 ID */
function resolveSessionId(params: any): string | undefined {
  // 检查 sessionKey 是否属于我们管理的会话
  const sessionKey = params?.request?.sessionKey || params?.sessionKey;
  if (!sessionKey) return undefined;

  // 我们管理的会话 key 格式: acp-manager:{agentId}:{sessionId}
  if (typeof sessionKey === "string" && sessionKey.startsWith("acp-manager:")) {
    const parts = sessionKey.split(":");
    return parts[2]; // sessionId
  }
  return undefined;
}

/** 构建 PendingApproval 对象 */
function buildPendingApproval(
  params: any,
  sessionId: string,
  defaultTimeoutMs: number,
): PendingApproval {
  const approvalId =
    params?.approvalId || params?.id || `approval_${Date.now()}`;
  const command = params?.command || params?.request?.command;
  const title = params?.title || command || "Permission Request";
  const toolName = params?.toolName || params?.request?.toolName;
  const description = params?.description || buildDescription(params);

  // 构建选项
  const options: ApprovalOption[] = [
    {
      id: "allow_once",
      label: "Allow Once",
      description: "Allow this action one time",
    },
    {
      id: "allow_always",
      label: "Allow Always",
      description: "Always allow this type of action",
    },
    { id: "reject", label: "Reject", description: "Deny this action" },
  ];

  // 优先级：单次 params 显式 > Plugin 配置默认
  const timeoutMs =
    typeof params?.timeoutMs === "number" && params.timeoutMs > 0
      ? params.timeoutMs
      : defaultTimeoutMs;

  return {
    approvalId,
    sessionId,
    toolName,
    title,
    description,
    options,
    timestamp: Date.now(),
    timeoutMs,
  };
}

function buildDescription(params: any): string | undefined {
  const parts: string[] = [];
  if (params?.command) parts.push(`Command: ${params.command}`);
  if (params?.host) parts.push(`Host: ${params.host}`);
  if (params?.request?.path) parts.push(`Path: ${params.request.path}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** 映射决策到 Gateway 格式 */
function mapDecisionToGateway(decision: ApprovalDecision): string {
  switch (decision) {
    case "allow_once":
      return "allow-once";
    case "allow_always":
      return "allow-always";
    case "reject":
      return "deny";
    case "cancel":
      return "deny";
    default:
      return "deny";
  }
}
