/**
 * Shared singletons for the ACP Session Manager plugin.
 *
 * 抽离 service 实例与 plugin API 引用以避免 `index.ts ↔ tools/* / hooks/*`
 * 之间的循环依赖：tools 与 hooks 仅依赖此模块，而 `index.ts` 在 register
 * 阶段写入 `pluginApi`、`start` 阶段使用同一个 `service` 实例。
 */

import { AcpSessionManagerService } from "./service.js";

/** 全局服务实例（在 Plugin 生命周期内存在） */
const service = new AcpSessionManagerService();

/** Plugin 注入的 API（在 register(api) 中由 index.ts 写入） */
let pluginApi: any = null;

export function getService(): AcpSessionManagerService {
  return service;
}

export function getPluginApi(): any {
  return pluginApi;
}

export function setPluginApi(api: any): void {
  pluginApi = api;
}
