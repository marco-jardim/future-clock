import { describe, expect, test } from "bun:test";
import { parseOptions } from "../../../src/plugin/options";
import type { ContextEvent } from "../../../src/plugin/ports";
import { createFakeHost } from "./fake-ctx";

const REAL_YEAR = 2026;

describe("parseOptions", () => {
  test("defaults to years 120 when options are absent or years is omitted", () => {
    expect(parseOptions(undefined, REAL_YEAR)).toEqual({ years: 120 });
    expect(parseOptions(null, REAL_YEAR)).toEqual({ years: 120 });
    expect(parseOptions({}, REAL_YEAR)).toEqual({ years: 120 });
  });

  test("accepts years 120", () => {
    expect(parseOptions({ years: 120 }, REAL_YEAR)).toEqual({ years: 120 });
  });

  test("accepts years -120", () => {
    expect(parseOptions({ years: -120 }, REAL_YEAR)).toEqual({ years: -120 });
  });

  test("rejects any key other than years", () => {
    expect(() => parseOptions({ years: 120, mode: "clock" }, REAL_YEAR)).toThrow(
      "future-clock: unknown option mode; the only option is `years`",
    );
    expect(() => parseOptions({ offset: 5 }, REAL_YEAR)).toThrow(
      "future-clock: unknown option offset; the only option is `years`",
    );
  });

  test("rejects years 2 (-3 < years < 4) via validateYears", () => {
    expect(() => parseOptions({ years: 2 }, REAL_YEAR)).toThrow(/years >= 4 or years <= -3/);
    expect(() => parseOptions({ years: "120" }, REAL_YEAR)).toThrow(/must be an integer/);
  });

  test("rejects non-object options", () => {
    expect(() => parseOptions(120, REAL_YEAR)).toThrow(/options must be an object/);
    expect(() => parseOptions("years=120", REAL_YEAR)).toThrow(/options must be an object/);
    expect(() => parseOptions([120], REAL_YEAR)).toThrow(/options must be an object/);
  });
});

function contextEvent(): ContextEvent {
  return { sessionID: "ses_1", system: [], messages: [], tools: {} };
}

describe("createFakeHost", () => {
  test("fires callbacks in registration order, awaiting each, and returns the same event", async () => {
    const host = createFakeHost();
    const order: string[] = [];
    host.register("context", async (event) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      event.system.push({ type: "text", text: "before" });
      order.push("before");
    });
    await host.ports.onContext((event) => {
      order.push(`plugin saw ${event.system.length}`);
      event.system.push({ type: "text", text: "plugin" });
    });
    host.register("context", (event) => {
      order.push(`after saw ${event.system.map((part) => part.text).join(",")}`);
    });

    const event = contextEvent();
    const returned = await host.fire.context(event);

    expect(returned).toBe(event);
    expect(order).toEqual(["before", "plugin saw 1", "after saw before,plugin"]);
    expect(host.registrations).toBe(3);
    host.ports.log("warn", "careful");
    expect(host.logs).toEqual([{ level: "warn", message: "careful" }]);
  });

  test("dispose removes exactly that registration", async () => {
    const host = createFakeHost();
    const calls: string[] = [];
    const shared = (): void => {
      calls.push("shared");
    };
    const first = await host.ports.onContext(shared);
    await host.ports.onContext(shared);
    const http = await host.ports.onHttpRequest(() => {
      calls.push("http");
    });
    expect(host.registrations).toBe(3);

    await first.dispose();
    await first.dispose();
    expect(host.registrations).toBe(2);
    await host.fire.context(contextEvent());
    expect(calls).toEqual(["shared"]);

    await http.dispose();
    expect(host.registrations).toBe(1);
    await host.fire.httpRequest({
      sessionID: "ses_1",
      kind: "primary",
      request: new Request("http://localhost/"),
    });
    expect(calls).toEqual(["shared"]);
  });
});
