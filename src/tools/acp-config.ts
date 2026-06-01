/**
 * acp_config - Update a config option for an ACP sub-session
 */

import { Type } from "@sinclair/typebox";
import { getService } from "../shared.js";
import { jsonResult, errorResult } from "../utils/result-helpers.js";

interface PluginToolContextLike {
  sessionKey?: string;
  agentId?: string;
}

const AcpConfigSchema = Type.Object({
  session_id: Type.String({
    description: "Target ACP session ID.",
  }),
  key: Type.String({
    description: 'Configuration key to update, e.g. "model".',
  }),
  value: Type.String({
    description: "New value for the configuration key.",
  }),
});

export function createAcpConfigTool(_ctx: PluginToolContextLike) {
  return {
    name: "acp_config",
    label: "ACP Config",
    description:
      'Update a runtime configuration option (e.g. "model") for an existing ACP sub-session. ' +
      "The change is forwarded to the underlying ACP runtime; not all keys are supported by every agent.",
    parameters: AcpConfigSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => {
      try {
        const service = getService();
        const sessionId = (params.session_id ?? params.sessionId) as string;
        const key = params.key as string;
        const value = params.value as string;
        await service.setConfig(sessionId, key, value);

        return jsonResult({
          status: "ok" as const,
          sessionId,
          key,
          value,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
