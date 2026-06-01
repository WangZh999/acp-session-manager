/**
 * acp_close - Close and release an ACP sub-session
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

interface PluginToolContextLike {
  sessionKey?: string;
  agentId?: string;
}

const AcpCloseSchema = Type.Object({
  session_id: Type.String({
    description: "Target ACP session ID to close.",
  }),
  reason: Type.Optional(
    Type.String({ description: "Optional human-readable reason for closing the session." }),
  ),
});

export function createAcpCloseTool(_ctx: PluginToolContextLike) {
  return {
    name: "acp_close",
    label: "ACP Close",
    description:
      "Close an ACP sub-session and remove it from the manager. " +
      "Any in-flight turn is terminated and the session record is dropped; subsequent acp_send/acp_cancel calls will fail.",
    parameters: AcpCloseSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => {
      try {
        const service = getService();
        const sessionId = (params.session_id ?? params.sessionId) as string;
        const reason = params.reason as string | undefined;
        await service.closeSession(sessionId, reason);

        return jsonResult({
          status: "ok" as const,
          sessionId,
          closed: true,
          reason,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
