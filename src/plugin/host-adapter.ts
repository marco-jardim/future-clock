/**
 * Adapts the real opencode plugin context (@opencode/plugin 2.0.27) to the
 * minimal `HostPorts` the plugin depends on.
 *
 * `execute.after` and `http.request` events are structural supersets of the
 * port event types and are passed straight through. The `context` event is
 * too, except for `messages`: the host `Message.content` is a *readonly* array
 * whose parts may carry `text: null` (compaction), which is not assignable to
 * the port's mutable `ContextMessage[]`. For that single field the adapter
 * hands the callback a typed view (accessors writing through to the real
 * message objects); `system` and `tools` are passed by reference. The port
 * hooks mutate in place, so writes through the view reach the host event.
 * A write the host object refuses (frozen part/message) is logged as a warning
 * instead of throwing, and the whole context callback is guarded: any error is
 * logged and never propagates to the host. No casts are used.
 */

import type { Plugin } from "@opencode/plugin";
import type { Callback, ContextEvent, ContextMessage, HostPorts } from "./ports";

const PREFIX = "[future-clock]";

type Log = HostPorts["log"];

/** What the adapter needs from a host message content part (host parts are structurally assignable). */
export interface HostPartLike {
  readonly type: string;
  text?: unknown;
}

/** What the adapter needs from a host message (host messages are structurally assignable). */
export interface HostMessageLike {
  readonly role: string;
  content: string | ReadonlyArray<HostPartLike>;
}

/**
 * What the adapter needs from the host `context` event (SessionContext is
 * structurally assignable). `messages` admits `undefined` so a malformed host
 * event is handled (rejected with a logged error) rather than assumed away.
 */
export interface HostContextLike {
  readonly sessionID: string;
  readonly agent?: string;
  readonly system: ContextEvent["system"];
  readonly messages: ReadonlyArray<HostMessageLike> | undefined;
  readonly tools: ContextEvent["tools"];
}

type ViewPart = Exclude<ContextMessage["content"], string>[number];

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function partView(part: HostPartLike, role: string, log: Log): ViewPart {
  return {
    get type(): string {
      return part.type;
    },
    get text(): string | undefined {
      return typeof part.text === "string" ? part.text : undefined;
    },
    set text(next: string | undefined) {
      if (typeof next !== "string") return;
      if (!Reflect.set(part, "text", next)) {
        log("warn", `context: host ${role} message part is read-only; rewrite not applied`);
      }
    },
  };
}

function messageView(message: HostMessageLike, log: Log): ContextMessage {
  return {
    get role(): string {
      return message.role;
    },
    get content(): ContextMessage["content"] {
      const content = message.content;
      return typeof content === "string"
        ? content
        : content.map((part) => partView(part, message.role, log));
    },
    set content(next: ContextMessage["content"]) {
      // Only string replacement is written through; array items are edited in place via partView.
      if (typeof next !== "string") return;
      if (!Reflect.set(message, "content", next)) {
        log("warn", `context: host ${message.role} message is read-only; rewrite not applied`);
      }
    },
  };
}

/**
 * Typed view over the host `context` event. Throws if the host event carries
 * no `messages` array (callers go through `guardContextCallback`, which logs).
 */
export function contextView(event: HostContextLike, log: Log): ContextEvent {
  const messages = event.messages;
  if (!Array.isArray(messages)) {
    throw new Error("context: host event has no messages array");
  }
  return {
    sessionID: event.sessionID,
    agent: event.agent,
    system: event.system,
    messages: messages.map((message) => messageView(message, log)),
    tools: event.tools,
  };
}

/**
 * Host-facing `context` callback: builds the view and runs the port callback;
 * any error (view or callback) is logged and never thrown to the host.
 */
export function guardContextCallback(
  cb: Callback<ContextEvent>,
  log: Log,
): (event: HostContextLike) => Promise<void> {
  return async (event) => {
    try {
      await cb(contextView(event, log));
    } catch (error) {
      log("error", `context: hook failed, event left as is: ${describeError(error)}`);
    }
  };
}

const log: Log = (level, message) => {
  if (level === "error") {
    console.error(`${PREFIX} ${message}`);
  } else {
    console.warn(`${PREFIX} ${message}`);
  }
};

export function hostPortsFromContext(ctx: Plugin.Context): HostPorts {
  return {
    onContext: (cb) => ctx.session.hook("context", guardContextCallback(cb, log)),
    onExecuteAfter: (cb) => ctx.tool.hook("execute.after", (event) => cb(event)),
    onHttpRequest: (cb) => ctx.session.hook("http.request", (event) => cb(event)),
    log,
  };
}
