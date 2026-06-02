/**
 * ACP Session Manager Plugin - Entry Point
 *
 * 直接集成 acpx runtime，无需通过 openclaw/plugin-sdk/acp-runtime-backend。
 * 审批通过 openclaw gateway 的 plugin.approval 系统处理，
 * 操作者在 UI 中直接看到原生审批弹窗并做出决策。
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
} from "./tools/index.js";
import { registerEventInjector } from "./hooks/event-injector.js";

export { getService, getPluginApi };

export default definePluginEntry({
  id: "acp-session-manager",
  name: "ACP Session Manager",
  description:
    "Manage ACP sub-sessions lifecycle with native gateway approval integration.",

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

    registerEventInjector(api);
  },
});
