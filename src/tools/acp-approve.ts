/**
 * acp_approve - Resolve a pending approval request from an ACP sub-session
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import type { ApprovalDecision } from "../types.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

interface PluginToolContextLike {
  sessionKey?: string;
  agentId?: string;
}

const DECISION_VALUES = ["allow_once", "allow_always", "reject", "cancel"] as const;

const AcpApproveSchema = Type.Object({
  session_id: Type.String({
    description: "ACP session ID that owns the pending approval.",
  }),
  approval_id: Type.String({
    description: "Approval ID from the surfaced approval request.",
  }),
  decision: Type.Union(
    DECISION_VALUES.map((d) => Type.Literal(d)),
    {
      description:
        'Decision to apply. "allow_once" allows this single action, "allow_always" persists the allow, "reject" denies, "cancel" aborts the tool call.',
    },
  ),
});

export function createAcpApproveTool(_ctx: PluginToolContextLike) {
  return {
    name: "acp_approve",
    label: "ACP Approve",
    description:
      "Resolve a pending approval request that was surfaced from an ACP sub-session. " +
      "Provide the session_id, the approval_id from the surfaced approval message, and a decision. " +
      'Use "allow_once" / "allow_always" to permit the action, "reject" to deny it, or "cancel" to abort the originating tool call.',
    parameters: AcpApproveSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => {
      try {
        const service = getService();
        const sessionId = (params.session_id ?? params.sessionId) as string;
        const approvalId = (params.approval_id ?? params.approvalId) as string;
        const decision = params.decision as ApprovalDecision;
        const resolved = service.resolveApproval(sessionId, approvalId, decision);

        if (!resolved) {
          return jsonResult({
            status: "error" as const,
            error: `Approval not found (sessionId=${sessionId}, approvalId=${approvalId}). It may have already been resolved or timed out.`,
          });
        }

        const session = service.getSession(sessionId);
        return jsonResult({
          status: "ok" as const,
          sessionId,
          approvalId,
          decision,
          remainingApprovalsCount: session?.pendingApprovals.length ?? 0,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
