import { describe, expect, test } from "bun:test";
import { createContextHook } from "../../../src/plugin/context-hook";
import type { ContextEvent, ContextMessage, SystemPart } from "../../../src/plugin/ports";
import { createFakeHost, type FakeHost } from "./fake-ctx";

const REAL_YEAR = 2026;
const YEARS = 120;

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    sessionID: "ses_test",
    system: [{ type: "text", text: "You are opencode.\nToday's date: Mon Oct 12 2026" }],
    messages: [],
    tools: {},
    ...overrides,
  };
}

async function setup(): Promise<FakeHost> {
  const host = createFakeHost();
  await host.ports.onContext(
    createContextHook({ years: YEARS, realYear: () => REAL_YEAR, log: host.ports.log }),
  );
  return host;
}

describe("createContextHook", () => {
  test("shifts the year of the date line in a system part, in place", async () => {
    const host = await setup();
    const part: SystemPart = { type: "text", text: "You are opencode.\nToday's date: Mon Oct 12 2026" };
    const system = [part];
    const event = makeEvent({ system });

    await host.fire.context(event);

    expect(event.system).toBe(system);
    expect(event.system[0]).toBe(part);
    expect(part.text).toBe("You are opencode.\nToday's date: Mon Oct 12 2146");
    expect(host.logs).toEqual([]);
  });

  test("rewrites a part added by another plugin, changing only the date-shaped year", async () => {
    const host = createFakeHost();
    host.register("context", (event) => {
      event.system.push({
        type: "text",
        text: "Router protocol v2026 — keep this header.\nToday's date: Mon Oct 12 2026",
      });
    });
    await host.ports.onContext(
      createContextHook({ years: YEARS, realYear: () => REAL_YEAR, log: host.ports.log }),
    );
    const event = makeEvent({ system: [] });

    await host.fire.context(event);

    expect(event.system).toEqual([
      { type: "text", text: "Router protocol v2026 — keep this header.\nToday's date: Mon Oct 12 2146" },
    ]);
  });

  test("shifts the date line even when it moved to a different part index", async () => {
    const host = await setup();
    const header: SystemPart = { type: "text", text: "You are opencode." };
    const rules: SystemPart = { type: "text", text: "Follow the rules of 2026 strictly." };
    const env: SystemPart = { type: "text", text: "<env>\nToday's date: Mon Oct 12 2026\n</env>" };
    const event = makeEvent({ system: [header, rules, env] });

    await host.fire.context(event);

    expect(header.text).toBe("You are opencode.");
    expect(rules.text).toBe("Follow the rules of 2026 strictly.");
    expect(env.text).toBe("<env>\nToday's date: Mon Oct 12 2146\n</env>");
  });

  test("never touches user, assistant or tool messages", async () => {
    const host = await setup();
    const messages: ContextMessage[] = [
      { role: "user", content: "Schedule it for 2026-10-12, Today's date: Mon Oct 12 2026" },
      { role: "assistant", content: [{ type: "text", text: "Booked for 2026-10-12." }] },
      { role: "tool", content: [{ type: "text", text: "The current year is 2026." }] },
    ];
    const before = structuredClone(messages);
    const event = makeEvent({ messages });

    await host.fire.context(event);

    expect(event.messages).toBe(messages);
    expect(event.messages).toEqual(before);
  });

  test("shifts role system rollover messages (string and array content)", async () => {
    const host = await setup();
    const stringMessage: ContextMessage = {
      role: "system",
      content: "Today's date is now: Tue Oct 13 2026",
    };
    const rolloverPart = { type: "text", text: "Today's date is now: Tue Oct 13 2026" };
    const otherPart = { type: "image", url: "file://2026-10-13.png" };
    const arrayContent = [rolloverPart, otherPart];
    const arrayMessage: ContextMessage = { role: "system", content: arrayContent };
    const event = makeEvent({ messages: [stringMessage, arrayMessage] });

    await host.fire.context(event);

    expect(stringMessage.content).toBe("Today's date is now: Tue Oct 13 2146");
    expect(arrayMessage.content).toBe(arrayContent);
    expect(rolloverPart.text).toBe("Today's date is now: Tue Oct 13 2146");
    expect(otherPart).toEqual({ type: "image", url: "file://2026-10-13.png" });
  });

  test("shifts tool descriptions with a year and leaves the others untouched", async () => {
    const host = await setup();
    const websearch = { description: "Search the web. The current year is 2026.", parameters: {} };
    const read = { description: "Reads a file from disk (v2026 API).", parameters: {} };
    const tools = { websearch, read };
    const event = makeEvent({ tools });

    await host.fire.context(event);

    expect(event.tools).toBe(tools);
    expect(event.tools["websearch"]).toBe(websearch);
    expect(websearch.description).toBe("Search the web. The current year is 2146.");
    expect(read.description).toBe("Reads a file from disk (v2026 API).");
  });

  test("is idempotent: three calls equal one", () => {
    const hook = createContextHook({ years: YEARS, realYear: () => REAL_YEAR, log: () => undefined });
    const build = (): ContextEvent =>
      makeEvent({
        system: [
          { type: "text", text: "Router protocol v2026\nToday's date: Mon Oct 12 2026" },
          { type: "text", text: "Released 2025-12-31, next 2027-01-01." },
        ],
        messages: [
          { role: "system", content: "Today's date is now: Tue Oct 13 2026" },
          { role: "user", content: "2026-10-12" },
        ],
        tools: { websearch: { description: "The current year is 2026." } },
      });
    const once = build();
    const thrice = build();

    hook(once);
    hook(thrice);
    hook(thrice);
    hook(thrice);

    expect(thrice).toEqual(once);
    expect(once.system[0]?.text).toBe("Router protocol v2026\nToday's date: Mon Oct 12 2146");
    expect(once.system[1]?.text).toBe("Released 2145-12-31, next 2147-01-01.");
  });

  test("logs and leaves the event unchanged when it fails, without throwing", async () => {
    const host = createFakeHost();
    const hook = createContextHook({
      years: YEARS,
      realYear: () => {
        throw new Error("clock unavailable");
      },
      log: host.ports.log,
    });
    await host.ports.onContext(hook);
    const event = makeEvent({
      messages: [{ role: "system", content: "Today's date is now: Tue Oct 13 2026" }],
      tools: { websearch: { description: "The current year is 2026." } },
    });
    const before = structuredClone(event);

    await host.fire.context(event);
    expect(() => hook(event)).not.toThrow();

    expect(event).toEqual(before);
    expect(host.logs).toEqual([
      { level: "error", message: "[future-clock] context hook failed: clock unavailable" },
      { level: "error", message: "[future-clock] context hook failed: clock unavailable" },
    ]);
  });
});
