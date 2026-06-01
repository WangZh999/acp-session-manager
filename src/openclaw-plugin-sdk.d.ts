declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginEntry {
    id: string;
    name?: string;
    description?: string;
    register(api: any): void;
  }
  export function definePluginEntry(entry: PluginEntry): PluginEntry;
}
