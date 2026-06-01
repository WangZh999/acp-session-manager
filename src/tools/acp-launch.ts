/**
 * acp_launch - Launch a new ACP sub-session
 *
 * Plugin SDK factory：由 `definePluginEntry().register()` 调用 `api.registerTool`
 * 时把 `OpenClawPluginToolContext` 注入进来，工具自身闭包持有 ctx 以读取
 * `sessionKey`、`agentId` 等运行时信息。
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

// 由 openclaw 提供的 ctx 类型 —— 在外部插件里以结构化方式使用，
// 不强制依赖 openclaw 内部模块解析（构建阶段不一定能 resolve openclaw 的私有路径）。
interface PluginToolContextLike {
  config?: unknown;
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}

const OUTPUT_PREVIEW_LIMIT = 500;

const AcpLaunchSchema = Type.Object({
  agent_id: Type.String({
    description:
      'Target ACP agent ID, e.g. "codex", "claude", "gemini". Must be registered with the ACP runtime.',
  }),
  task: Type.String({
    description: "Initial task description / prompt sent to the agent for the first turn.",
  }),
  mode: Type.Optional(
    Type.Union([Type.Literal("run"), Type.Literal("session")], {
      description:
        'Session mode. "run" = one-shot execution (default). "session" = persistent, multi-turn conversation that supports acp_send.',
      default: "run",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional model override forwarded to the ACP agent." }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the spawned ACP agent." }),
  ),
});

export function createAcpLaunchTool(ctx: PluginToolContextLike) {
  return {
    name: "acp_launch",
    label: "ACP Launch",
    description:
      "Launch a new ACP sub-session driven by an external coding agent (e.g. codex, claude, gemini). " +
      'Use mode="run" for a one-shot task and mode="session" for a multi-turn conversation that can be resumed via acp_send. ' +
      "Returns the new sessionId, current status, stop reason, and a short preview of the agent output.",
    parameters: AcpLaunchSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => {
      try {
        const service = getService();
        // 兼容 snake_case (schema 定义) 与 camelCase (框架可能转换)
        const agentId = (params.agent_id ?? params.agentId) as string;
        const task = params.task as string;
        // 父 sessionKey 在 factory ctx 中由宿主注入，调用时直接复用闭包值
        const parentSessionKey = ctx?.sessionKey;
        const cwd = (params.cwd as string | undefined) ?? ctx?.workspaceDir;

        const session = await service.launchSession({
          agentId,
          task,
          mode: params.mode === "session" ? "session" : "run",
          model: params.model as string | undefined,
          cwd,
          parentSessionKey,
        });

        const output = session.output ?? "";
        const truncated = output.length > OUTPUT_PREVIEW_LIMIT;
        const preview = truncated ? output.slice(0, OUTPUT_PREVIEW_LIMIT) : output;

        return jsonResult({
          status: "ok" as const,
          sessionId: session.sessionId,
          agentId: session.agentId,
          sessionStatus: session.status,
          mode: session.mode,
          stopReason: session.lastStopReason,
          error: session.error,
          outputPreview: preview,
          outputTruncated: truncated,
          outputLength: output.length,
          pendingApprovalsCount: session.pendingApprovals.length,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
