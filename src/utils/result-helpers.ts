/**
 * AgentToolResult helpers for plugin tool execute() return values.
 *
 * 所有 OpenClaw 插件工具的 execute() 必须返回符合 AgentToolResult 接口的对象：
 *   { content: (TextContent | ImageContent)[], details: T }
 *
 * 这里提供 jsonResult() 简化将任意结构化 payload 序列化成符合规范的返回值。
 */

export interface AgentToolResultLike<T = unknown> {
  content: { type: "text"; text: string }[];
  details: T;
  terminate?: boolean;
}

/**
 * 将任意结构化 payload 包装成 AgentToolResult。
 * - content: 一段 JSON 文本（缩进 2 空格），供模型阅读
 * - details: 原始结构化对象，供 UI / 日志使用
 */
export function jsonResult<T>(payload: T): AgentToolResultLike<T> {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

/** 工具内部抛错时的统一错误返回。 */
export function errorResult(err: unknown): AgentToolResultLike<{
  status: "error";
  error: string;
}> {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ status: "error" as const, error: message });
}
