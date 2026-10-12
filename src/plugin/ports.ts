/**
 * Host ports (U2–U4, U8): the minimal shapes the plugin needs from opencode.
 * Shapes mirror the verified runtime of opencode v2.0.27 / @opencode/plugin 2.0.27,
 * narrowed to the fields the plugin reads or writes.
 */

export type TextPart = { type: "text"; text: string; [key: string]: unknown };
export type SystemPart = TextPart;
export interface ContextMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface ContextEvent {
  readonly sessionID: string;
  readonly agent?: string;
  system: SystemPart[];
  messages: ContextMessage[];
  tools: Record<string, { description: string; [key: string]: unknown }>;
}
export type ToolContentItem =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string };
export interface ToolResultLike {
  readonly output?: unknown;
  readonly content?: string | ReadonlyArray<ToolContentItem>;
  readonly metadata?: unknown;
}
export type ExecuteAfterEvent = {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
} & (
  | { readonly status: "completed"; result: ToolResultLike }
  | { readonly status: "error"; error: { message: string } }
);
export interface HttpRequestEvent {
  readonly sessionID: string;
  readonly kind: string;
  request: Request;
}
export interface Registration {
  dispose(): Promise<void>;
}
export type Callback<E> = (event: E) => Promise<void> | void;
export interface HostPorts {
  onContext(cb: Callback<ContextEvent>): Promise<Registration>;
  onExecuteAfter(cb: Callback<ExecuteAfterEvent>): Promise<Registration>;
  onHttpRequest(cb: Callback<HttpRequestEvent>): Promise<Registration>;
  log(level: "warn" | "error", message: string): void;
}
