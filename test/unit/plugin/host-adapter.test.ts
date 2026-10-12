import { describe, expect, test } from "bun:test";
import { createContextHook } from "../../../src/plugin/context-hook";
import {
  contextView,
  guardContextCallback,
  type HostContextLike,
  type HostMessageLike,
} from "../../../src/plugin/host-adapter";
import type { HostPorts } from "../../../src/plugin/ports";

/*
 * `hostPortsFromContext` needs a full `Plugin.Context` (25+ host domains), which
 * cannot be faked without casts. These tests exercise the exact callback it
 * registers for "context" (`guardContextCallback` → `contextView`) with the real
 * `createContextHook`.
 */

interface LogEntry {
  level: "warn" | "error";
  message: string;
}

function collector(): { logs: LogEntry[]; log: HostPorts["log"] } {
  const logs: LogEntry[] = [];
  return { logs, log: (level, message) => logs.push({ level, message }) };
}

function hostEvent(messages: ReadonlyArray<HostMessageLike> | undefined): HostContextLike {
  return {
    sessionID: "ses_test",
    system: [{ type: "text", text: "Today's date: Mon Oct 12 2026" }],
    messages,
    tools: {},
  };
}

function hostContextCallback(log: HostPorts["log"]): (event: HostContextLike) => Promise<void> {
  const hook = createContextHook({ years: 120, realYear: () => 2026, log });
  return guardContextCallback(hook, log);
}

const ROLLOVER = "Today's date is now: Tue Oct 13 2026";

describe("host adapter: context callback", () => {
  test("role system part inside a frozen content array is rewritten on the host object", async () => {
    const { logs, log } = collector();
    const part = { type: "text", text: ROLLOVER };
    const content = Object.freeze([part]);
    const message: HostMessageLike = { role: "system", content };

    await hostContextCallback(log)(hostEvent([message]));

    expect(message.content).toBe(content);
    expect(content[0]).toBe(part);
    expect(part.text.endsWith("2146")).toBe(true);
    expect(part.text).toBe("Today's date is now: Tue Oct 13 2146");
    expect(logs).toEqual([]);
  });

  test("frozen part object: rewrite cannot reach the host, warning logged, no throw", async () => {
    const { logs, log } = collector();
    const part = Object.freeze({ type: "text", text: ROLLOVER });
    const message: HostMessageLike = { role: "system", content: Object.freeze([part]) };

    await expect(hostContextCallback(log)(hostEvent([message]))).resolves.toBeUndefined();

    expect(part.text).toBe(ROLLOVER);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.message).toContain("read-only");
  });

  test("compaction part with text null is left untouched, nothing logged", async () => {
    const { logs, log } = collector();
    const compaction = { type: "compaction", text: null };
    const message: HostMessageLike = { role: "system", content: Object.freeze([compaction]) };

    await hostContextCallback(log)(hostEvent([message]));

    expect(compaction).toStrictEqual({ type: "compaction", text: null });
    expect(logs).toEqual([]);
  });

  test("messages undefined: no throw, exactly one error logged, event left as is", async () => {
    const { logs, log } = collector();
    const event = hostEvent(undefined);

    await expect(hostContextCallback(log)(event)).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("error");
    expect(logs[0]?.message).toContain("messages");
    expect(event.system[0]?.text).toBe("Today's date: Mon Oct 12 2026");
  });

  test("a throwing port callback is logged and never reaches the host", async () => {
    const { logs, log } = collector();
    const guarded = guardContextCallback(() => {
      throw new Error("boom");
    }, log);

    await expect(guarded(hostEvent([]))).resolves.toBeUndefined();

    expect(logs).toEqual([{ level: "error", message: "context: hook failed, event left as is: boom" }]);
  });

  test("a rejecting async port callback is logged and never reaches the host", async () => {
    const { logs, log } = collector();
    const guarded = guardContextCallback(async () => {
      throw new Error("async boom");
    }, log);

    await expect(guarded(hostEvent([]))).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain("async boom");
  });
});

describe("contextView", () => {
  test("passes system and tools by reference and keeps ids", () => {
    const { log } = collector();
    const event: HostContextLike = {
      sessionID: "ses_view",
      agent: "build",
      system: [{ type: "text", text: "s" }],
      messages: [],
      tools: { bash: { description: "d" } },
    };

    const view = contextView(event, log);

    expect(view.sessionID).toBe("ses_view");
    expect(view.agent).toBe("build");
    expect(view.system).toBe(event.system);
    expect(view.tools).toBe(event.tools);
    expect(view.messages).toEqual([]);
  });

  test("string content is written through to the host message", () => {
    const { logs, log } = collector();
    const message: HostMessageLike = { role: "system", content: "old" };
    const view = contextView(hostEvent([message]), log);

    const first = view.messages[0];
    expect(first?.role).toBe("system");
    if (first !== undefined) first.content = "new";

    expect(message.content).toBe("new");
    expect(logs).toEqual([]);
  });

  test("frozen message: string rewrite is refused with a warning, no throw", () => {
    const { logs, log } = collector();
    const message: HostMessageLike = Object.freeze({ role: "system", content: "old" });
    const view = contextView(hostEvent([message]), log);

    const first = view.messages[0];
    if (first !== undefined) first.content = "new";

    expect(message.content).toBe("old");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
  });

  test("non-string part text reads as undefined and ignores undefined writes", () => {
    const { logs, log } = collector();
    const compaction = { type: "compaction", text: null };
    const view = contextView(hostEvent([{ role: "system", content: [compaction] }]), log);

    const content = view.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const part = content[0];
      expect(part?.type).toBe("compaction");
      expect(part?.text).toBeUndefined();
      if (part !== undefined) part.text = undefined;
    }

    expect(compaction.text).toBeNull();
    expect(logs).toEqual([]);
  });

  test("throws on a host event without messages array", () => {
    const { log } = collector();
    expect(() => contextView(hostEvent(undefined), log)).toThrow(/messages/);
  });
});
