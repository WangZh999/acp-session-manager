/**
 * acp_send - Send a follow-up message to an active ACP sub-session
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

interface PluginToolContextLike {
  sessionKey?: string;
  agentId?: string;
}

const OUTPUT_PREVIEW_LIMIT = 500;

const AcpSendSchema = Type.Object({
  session_id: Type.String({
    description: "Target ACP session ID returned by acp_launch.",
  }),
  message: Type.String({
    description: "Message / instruction to send to the agent for the next turn.",
  }),
});

export function createAcpSendTool(_ctx: PluginToolContextLike) {
  return {
    name: "acp_send",
    label: "ACP Send",
    description:
      "Send a follow-up message / instruction to an existing ACP sub-session and wait for the next turn to complete. " +
      'Only works on sessions that were launched with mode="session" (or are otherwise still active). ' +
      "Returns the turn status, stop reason, and a short preview of the cumulative agent output.",
    parameters: AcpSendSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      onUpdate?: (result: unknown) => void,
    ) => {
      try {
        const service = getService();
        const sessionId = (params.session_id ?? params.sessionId) as string;
        const result = await service.sendMessage(sessionId, params.message as string, onUpdate);

        const output = result.output ?? "";
        const truncated = output.length > OUTPUT_PREVIEW_LIMIT;
        const preview = truncated ? output.slice(0, OUTPUT_PREVIEW_LIMIT) : output;

        return jsonResult({
          status: "ok" as const,
          sessionId,
          turnStatus: result.status,
          stopReason: result.stopReason,
          error: result.error,
          outputPreview: preview,
          outputTruncated: truncated,
          outputLength: output.length,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
