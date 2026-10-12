/**
 * Plan task 1.8 / QA-1 M1: edge cases of the whole plugin (setupWith + fake
 * host): year rollover between the context hook and the HTTP boundary,
 * negative offsets, CRLF/markdown, compact clock formats, bare years and a
 * throwing neighbour.
 */

import { describe, expect, test } from "bun:test";
import { setupWith } from "../../src/plugin/index";
import type { ContextEvent, ExecuteAfterEvent, HttpRequestEvent, SystemPart } from "../../src/plugin/ports";
import {
  SHELL_TOOL_USE_ID,
  type WireBody,
  type WireMessage,
  type WireTextBlock,
} from "./fixtures/wire-body";
import { createFakeHost, type FakeHost } from "./plugin/fake-ctx";

const OCT_12_2026 = (): Date => new Date(2026, 9, 12);

interface MutableClock {
  readonly now: () => Date;
  set(date: Date): void;
}

function mutableClock(start: Date): MutableClock {
  let current = start;
  return {
    now: () => current,
    set: (date) => {
      current = date;
    },
  };
}

async function install(years: number, now: () => Date): Promise<FakeHost> {
  const host = createFakeHost();
  await setupWith(host.ports, { years }, {}, now);
  return host;
}

function contextEvent(system: readonly string[], tools: Record<string, string> = {}): ContextEvent {
  const toolMap: ContextEvent["tools"] = {};
  for (const [name, description] of Object.entries(tools)) toolMap[name] = { description };
  return {
    sessionID: "ses_edge",
    system: system.map((text): SystemPart => ({ type: "text", text })),
    messages: [],
    tools: toolMap,
  };
}

function shellEvent(command: string, output: string): ExecuteAfterEvent {
  return {
    tool: "shell",
    sessionID: "ses_edge",
    input: { command },
    status: "completed",
    result: { output },
  };
}

function outputOf(event: ExecuteAfterEvent): string {
  if (event.status !== "completed") throw new Error("expected a completed shell event");
  const output = event.result.output;
  if (typeof output !== "string") throw new Error("expected a string shell output");
  return output;
}

interface ShellCall {
  command: string;
  output: string;
}

/** Anthropic Messages body JSON with the given system parts, tools and optional shell call. */
function bodyJson(system: readonly string[], tools: Record<string, string>, shell?: ShellCall): string {
  const messages: WireMessage[] = [{ role: "user", content: "que dia é hoje?" }];
  if (shell !== undefined) {
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: SHELL_TOOL_USE_ID, name: "shell", input: { command: shell.command } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: SHELL_TOOL_USE_ID, content: shell.output }],
      },
    );
  }
  const body: WireBody = {
    model: "claude-haiku-5-5",
    system: system.map((text): WireTextBlock => ({ type: "text", text })),
    tools: Object.entries(tools).map(([name, description]) => ({
      name,
      description,
      input_schema: { type: "object", properties: {} },
    })),
    messages,
    stream: true,
    max_tokens: 32000,
    thinking: { type: "enabled", budget_tokens: 1024 },
  };
  return JSON.stringify(body);
}

function contextBodyJson(context: ContextEvent, shell?: ShellCall): string {
  const tools: Record<string, string> = {};
  for (const [name, tool] of Object.entries(context.tools)) tools[name] = tool.description;
  return bodyJson(
    context.system.map((part) => part.text),
    tools,
    shell,
  );
}

function httpEvent(body: string): HttpRequestEvent {
  return {
    sessionID: "ses_edge",
    kind: "chat",
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  };
}

interface Sent {
  system: string[];
  descriptions: string[];
  results: string[];
}

async function sent(event: HttpRequestEvent): Promise<Sent> {
  const body: WireBody = JSON.parse(await event.request.text());
  const system = typeof body.system === "string" ? [body.system] : body.system.map((part) => part.text);
  const results: string[] = [];
  for (const message of body.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      if (typeof block.content === "string") results.push(block.content);
      else for (const item of block.content) results.push(item.text);
    }
  }
  return { system, descriptions: body.tools.map((tool) => tool.description), results };
}

describe("edge cases (task 1.8)", () => {
  for (const years of [120, 4]) {
    test(`Dec→Jan: context at 2026-12-31, boundary at 2027-01-01 — no double shift (years ${years})`, async () => {
      const clock = mutableClock(new Date(2026, 11, 31, 23, 59, 0));
      const host = await install(years, clock.now);
      const shifted = 2026 + years;
      const doubled = shifted + years;

      const context = await host.fire.context(
        contextEvent(["Today's date: Thu Dec 31 2026"], { websearch: "The current year is 2026." }),
      );
      const shell = await host.fire.executeAfter(
        shellEvent("Get-Date", "\r\nquinta-feira, 31 de dezembro de 2026 23:59:00\r\n\r\n"),
      );
      expect(context.system[0]?.text).toBe(`Today's date: Thu Dec 31 ${shifted}`);
      expect(context.tools.websearch?.description).toBe(`The current year is ${shifted}.`);
      expect(outputOf(shell)).toBe(`\r\nquinta-feira, 31 de dezembro de ${shifted} 23:59:00\r\n\r\n`);

      // The request leaves after midnight: the real year is now 2027.
      clock.set(new Date(2027, 0, 1, 0, 0, 30));
      const http = await host.fire.httpRequest(
        httpEvent(contextBodyJson(context, { command: "Get-Date", output: outputOf(shell) })),
      );
      const body = await sent(http);

      expect(body.system).toEqual([`Today's date: Thu Dec 31 ${shifted}`]);
      expect(body.descriptions).toEqual([`The current year is ${shifted}.`]);
      expect(body.results).toEqual([`\r\nquinta-feira, 31 de dezembro de ${shifted} 23:59:00\r\n\r\n`]);
      expect(JSON.stringify(body)).not.toContain(String(doubled));
      expect(host.logs).toEqual([]);
    });
  }

  test("years -120 shifts 2026 back to 1906 (context, tool and boundary)", async () => {
    const host = await install(-120, OCT_12_2026);

    const context = await host.fire.context(contextEvent(["Today's date: Mon Oct 12 2026"]));
    const shell = await host.fire.executeAfter(shellEvent("Get-Date", "segunda-feira, 12 de outubro de 2026 16:20:00"));
    expect(context.system[0]?.text).toBe("Today's date: Mon Oct 12 1906");
    expect(outputOf(shell)).toBe("segunda-feira, 12 de outubro de 1906 16:20:00");

    // A body the hooks never saw is fixed by the boundary with the same offset.
    const http = await host.fire.httpRequest(
      httpEvent(
        bodyJson(["Today's date: Mon Oct 12 2026"], {}, { command: "Get-Date", output: "2026-10-12" }),
      ),
    );
    const body = await sent(http);
    expect(body.system).toEqual(["Today's date: Mon Oct 12 1906"]);
    expect(body.results).toEqual(["1906-10-12"]);
  });

  test("CRLF and markdown bold around an ISO date in the system prompt", async () => {
    const host = await install(120, OCT_12_2026);
    const text = "# Notes\r\nRelease: **2026-10-12**\r\nToday's date: Mon Oct 12 2026\r\n";
    const expected = "# Notes\r\nRelease: **2146-10-12**\r\nToday's date: Mon Oct 12 2146\r\n";

    const context = await host.fire.context(contextEvent([text]));
    expect(context.system[0]?.text).toBe(expected);

    const http = await host.fire.httpRequest(httpEvent(bodyJson([text], {})));
    expect((await sent(http)).system).toEqual([expected]);
  });

  test("compact timestamp 2026-10-12_14-30 in a clock output", async () => {
    const host = await install(120, OCT_12_2026);
    const command = 'Get-Date -Format "yyyy-MM-dd_HH-mm"';

    const shell = await host.fire.executeAfter(shellEvent(command, "2026-10-12_14-30\r\n"));
    expect(outputOf(shell)).toBe("2146-10-12_14-30\r\n");

    const http = await host.fire.httpRequest(
      httpEvent(bodyJson([], {}, { command, output: "2026-10-12_14-30\r\n" })),
    );
    expect((await sent(http)).results).toEqual(["2146-10-12_14-30\r\n"]);
  });

  test("bare 2026 stays in the system prompt but is shifted in a classified clock output", async () => {
    const host = await install(120, OCT_12_2026);
    const command = "Get-Date -Format yyyy";

    const context = await host.fire.context(contextEvent(["2026"]));
    const shell = await host.fire.executeAfter(shellEvent(command, "2026"));
    expect(context.system[0]?.text).toBe("2026");
    expect(outputOf(shell)).toBe("2146");

    const http = await host.fire.httpRequest(httpEvent(bodyJson(["2026"], {}, { command, output: "2026" })));
    const body = await sent(http);
    expect(body.system).toEqual(["2026"]);
    expect(body.results).toEqual(["2146"]);
  });

  test("a neighbour that throws in context after the plugin: the plugin's shift is already applied", async () => {
    const host = await install(120, OCT_12_2026);
    let neighbourRuns = 0;
    host.register("context", () => {
      neighbourRuns += 1;
      throw new Error("neighbour exploded");
    });

    const event = contextEvent(["Today's date: Mon Oct 12 2026"], { websearch: "The current year is 2026." });
    await expect(host.fire.context(event)).rejects.toThrow("neighbour exploded");
    expect(neighbourRuns).toBe(1);
    expect(event.system[0]?.text).toBe("Today's date: Mon Oct 12 2146");
    expect(event.tools.websearch?.description).toBe("The current year is 2146.");

    const http = await host.fire.httpRequest(httpEvent(contextBodyJson(event)));
    const body = await sent(http);
    expect(body.system).toEqual(["Today's date: Mon Oct 12 2146"]);
    expect(body.descriptions).toEqual(["The current year is 2146."]);
    expect(host.logs).toEqual([]);
  });

  test("a neighbour that throws in context before the plugin: the boundary still applies", async () => {
    const host = createFakeHost();
    host.register("context", () => {
      throw new Error("neighbour exploded");
    });
    await setupWith(host.ports, { years: 120 }, {}, OCT_12_2026);
    expect(host.registrations).toBe(1 + 3);

    // The host aborts the chain before the plugin's context hook runs...
    const event = contextEvent(["Today's date: Mon Oct 12 2026"], { websearch: "The current year is 2026." });
    await expect(host.fire.context(event)).rejects.toThrow("neighbour exploded");
    expect(event.system[0]?.text).toBe("Today's date: Mon Oct 12 2026");

    // ...and the HTTP boundary still shifts what goes on the wire.
    const http = await host.fire.httpRequest(httpEvent(contextBodyJson(event)));
    const body = await sent(http);
    expect(body.system).toEqual(["Today's date: Mon Oct 12 2146"]);
    expect(body.descriptions).toEqual(["The current year is 2146."]);
  });
});
