/**
 * acp_list - List managed ACP sub-sessions
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import type { AcpSessionStatus } from "../types.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

interface PluginToolContextLike {
  sessionKey?: string;
  agentId?: string;
}

const STATUS_VALUES = [
  "initializing",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

const AcpListSchema = Type.Object({
  status: Type.Optional(
    Type.Union(
      STATUS_VALUES.map((s) => Type.Literal(s)),
      {
        description:
          "Optional status filter. Only sessions matching the given status will be returned.",
      },
    ),
  ),
});

export function createAcpListTool(_ctx: PluginToolContextLike) {
  return {
    name: "acp_list",
    label: "ACP List",
    description:
      "List all managed ACP sub-sessions with their status and pending approval counts. " +
      "Optionally filter by status. Use this tool to discover active sessions before sending follow-up messages or processing approvals.",
    parameters: AcpListSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => {
      try {
        const service = getService();
        const filter =
          typeof params?.status === "string"
            ? { status: params.status as AcpSessionStatus }
            : undefined;
        const sessions = service.listSessions(filter);

        return jsonResult({
          status: "ok" as const,
          count: sessions.length,
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            agentId: s.agentId,
            sessionStatus: s.status,
            mode: s.mode,
            createdAt: s.createdAt,
            lastActiveAt: s.lastActiveAt,
            pendingApprovalsCount: s.pendingApprovals.length,
            stopReason: s.lastStopReason,
            error: s.error,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
