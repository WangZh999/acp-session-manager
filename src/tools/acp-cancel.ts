/**
 * acp_cancel - Cancel an in-flight ACP sub-session turn
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

interface PluginToolContextLike {
  sessionKey?: string;
  agentId?: string;
}

const AcpCancelSchema = Type.Object({
  session_id: Type.String({
    description: "Target ACP session ID to cancel.",
  }),
  reason: Type.Optional(
    Type.String({ description: "Optional human-readable reason for the cancellation." }),
  ),
});

export function createAcpCancelTool(_ctx: PluginToolContextLike) {
  return {
    name: "acp_cancel",
    label: "ACP Cancel",
    description:
      "Cancel the currently executing turn of an ACP sub-session. " +
      "The session record is kept so its output and history can still be inspected; use acp_close to fully release it.",
    parameters: AcpCancelSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => {
      try {
        const service = getService();
        const sessionId = (params.session_id ?? params.sessionId) as string;
        const reason = params.reason as string | undefined;
        await service.cancelSession(sessionId, reason);
        const session = service.getSession(sessionId);

        return jsonResult({
          status: "ok" as const,
          sessionId,
          sessionStatus: session?.status ?? "cancelled",
          reason,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
