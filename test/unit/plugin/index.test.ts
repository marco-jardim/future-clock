import { describe, expect, test } from "bun:test";
import { setupWith } from "../../../src/plugin/index";
import type { ContextEvent } from "../../../src/plugin/ports";
import { createFakeHost } from "./fake-ctx";

const fixedNow = (): Date => new Date(2026, 9, 12);

describe("setupWith", () => {
  test("registers exactly 3 callbacks (context, execute.after, http.request)", async () => {
    const host = createFakeHost();
    const cleanup = await setupWith(host.ports, undefined, {}, fixedNow);
    expect(host.registrations).toBe(3);
    await cleanup();
  });

  test("cleanup disposes every registration", async () => {
    const host = createFakeHost();
    const cleanup = await setupWith(host.ports, { years: 120 }, {}, fixedNow);
    expect(host.registrations).toBe(3);
    await cleanup();
    expect(host.registrations).toBe(0);
    expect(host.logs).toEqual([]);
  });

  test("invalid years throws and registers nothing", async () => {
    const host = createFakeHost();
    await expect(setupWith(host.ports, { years: Number.NaN }, {}, fixedNow)).rejects.toThrow();
    expect(host.registrations).toBe(0);
  });

  test("unknown option throws a clear error", async () => {
    const host = createFakeHost();
    await expect(setupWith(host.ports, { years: 120, foo: 1 }, {}, fixedNow)).rejects.toThrow(
      /unknown option foo/,
    );
    expect(host.registrations).toBe(0);
  });

  test("relative FUTURE_CLOCK_DUMP_DIR throws", async () => {
    const host = createFakeHost();
    await expect(
      setupWith(host.ports, undefined, { FUTURE_CLOCK_DUMP_DIR: "relative/dumps" }, fixedNow),
    ).rejects.toThrow(/FUTURE_CLOCK_DUMP_DIR/);
    expect(host.registrations).toBe(0);
  });

  test("end-to-end: context date line is shifted to 2146", async () => {
    const host = createFakeHost();
    const cleanup = await setupWith(host.ports, undefined, {}, fixedNow);
    const event: ContextEvent = {
      sessionID: "ses_test",
      system: [{ type: "text", text: "Today's date: Mon Oct 12 2026" }],
      messages: [],
      tools: {},
    };
    const out = await host.fire.context(event);
    const text = out.system.map((part) => part.text).join("\n");
    expect(text).toContain("2146");
    expect(text).not.toContain("2026");
    await cleanup();
  });
});
