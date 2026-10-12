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
 * No casts are used.
 */

import type { Plugin } from "@opencode/plugin";
import type { Callback, ContextEvent, ContextMessage, HostPorts } from "./ports";

const PREFIX = "[future-clock]";

/** What the adapter needs from a host message content part (host parts are structurally assignable). */
interface HostPartLike {
  readonly type: string;
  text?: unknown;
}

/** What the adapter needs from a host message (host messages are structurally assignable). */
interface HostMessageLike {
  readonly role: string;
  content: string | ReadonlyArray<HostPartLike>;
}

/** What the adapter needs from the host `context` event (SessionContext is structurally assignable). */
interface HostContextLike {
  readonly sessionID: string;
  readonly agent?: string;
  readonly system: ContextEvent["system"];
  readonly messages: ReadonlyArray<HostMessageLike>;
  readonly tools: ContextEvent["tools"];
}

type ViewPart = Exclude<ContextMessage["content"], string>[number];

function partView(part: HostPartLike): ViewPart {
  return {
    get type(): string {
      return part.type;
    },
    get text(): string | undefined {
      return typeof part.text === "string" ? part.text : undefined;
    },
    set text(next: string | undefined) {
      if (typeof next === "string") part.text = next;
    },
  };
}

function messageView(message: HostMessageLike): ContextMessage {
  return {
    get role(): string {
      return message.role;
    },
    get content(): ContextMessage["content"] {
      const content = message.content;
      return typeof content === "string" ? content : content.map(partView);
    },
    set content(next: ContextMessage["content"]) {
      // Only string replacement is written through; array items are edited in place via partView.
      if (typeof next === "string") message.content = next;
    },
  };
}

function contextView(event: HostContextLike): ContextEvent {
  return {
    sessionID: event.sessionID,
    agent: event.agent,
    system: event.system,
    messages: event.messages.map(messageView),
    tools: event.tools,
  };
}

function onContextVia(ctx: Plugin.Context, cb: Callback<ContextEvent>): ReturnType<HostPorts["onContext"]> {
  return ctx.session.hook("context", (event) => cb(contextView(event)));
}

export function hostPortsFromContext(ctx: Plugin.Context): HostPorts {
  return {
    onContext: (cb) => onContextVia(ctx, cb),
    onExecuteAfter: (cb) => ctx.tool.hook("execute.after", (event) => cb(event)),
    onHttpRequest: (cb) => ctx.session.hook("http.request", (event) => cb(event)),
    log: (level, message) => {
      if (level === "error") {
        console.error(`${PREFIX} ${message}`);
      } else {
        console.warn(`${PREFIX} ${message}`);
      }
    },
  };
}
