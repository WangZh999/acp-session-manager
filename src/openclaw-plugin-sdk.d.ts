declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginEntry {
    id: string;
    name?: string;
    description?: string;
    register(api: any): void;
  }
  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}

declare module "openclaw/plugin-sdk/acp-runtime-backend" {
  export function requireAcpRuntimeBackend(id: string): {
    runtime: unknown;
    [key: string]: unknown;
  };
}
