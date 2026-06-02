declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginEntry {
    id: string;
    name?: string;
    description?: string;
    register(api: any): void;
  }
  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}

declare module "openclaw/plugin-sdk/agent-harness-runtime" {
  export type GatewayCallOptions = {
    gatewayUrl?: string;
    timeoutMs?: number;
  };
  export function callGatewayTool<T = Record<string, unknown>>(
    method: string,
    opts: GatewayCallOptions,
    params?: unknown,
    extra?: { expectFinal?: boolean; scopes?: string[] },
  ): Promise<T>;
}
