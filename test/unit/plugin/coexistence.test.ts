/**
 * Plan task 1.8 / QA-1 M1: the plugin coexists with neighbour plugins hooked on
 * the same events, before and after it. Late neighbours win at the hook level
 * (they write real-year dates back after the plugin ran); the HTTP boundary
 * final pass (L3) is the last word and fixes what actually goes on the wire.
 */

import { describe, expect, test } from "bun:test";
import { setupWith } from "../../../src/plugin/index";
import type { ContextEvent, ExecuteAfterEvent, HttpRequestEvent } from "../../../src/plugin/ports";
import {
  PT_BR_GET_DATE_OUTPUT,
  SHELL_DESCRIPTION,
  SHELL_TOOL_USE_ID,
  SYSTEM_MAIN_TEXT,
  USER_QUESTION,
  WEBSEARCH_DESCRIPTION,
  type WireBody,
  type WireTextBlock,
} from "../fixtures/wire-body";
import { createFakeHost } from "./fake-ctx";

const NOW = (): Date => new Date(2026, 9, 12);
const YEARS = 120;
const ROUTER_LINE = "Router v2026 — keep";
const ROUTER_PART = `${ROUTER_LINE}\nToday's date: Mon Oct 12 2026`;
const NEIGHBOUR_URL = "http://127.0.0.1:51234/v1/messages";
const LATE_YEAR_SENTENCE = "The current year is 2026.";
const LATE_CLOCK_SUFFIX = "\n2026-10-12";

/** A bare 2025/2026/2027 token (a version like "v2026" is excluded by the lookbehind). */
const REAL_YEAR_TOKEN = /(?<![A-Za-z0-9])(?:2025|2026|2027)(?![0-9])/;

function makeContextEvent(): ContextEvent {
  return {
    sessionID: "ses_coexist",
    system: [{ type: "text", text: SYSTEM_MAIN_TEXT }],
    messages: [],
    tools: {
      websearch: { description: WEBSEARCH_DESCRIPTION },
      shell: { description: SHELL_DESCRIPTION },
    },
  };
}

function makeShellEvent(output: string): ExecuteAfterEvent {
  return {
    tool: "shell",
    sessionID: "ses_coexist",
    input: { command: "Get-Date" },
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

/** Anthropic Messages body built from what the hooks left in the context and tool events. */
function buildBody(context: ContextEvent, shellOutput: string): WireBody {
  return {
    model: "claude-haiku-5-5",
    system: context.system.map((part): WireTextBlock => ({ type: "text", text: part.text })),
    tools: Object.entries(context.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      input_schema: { type: "object", properties: {} },
    })),
    messages: [
      { role: "user", content: USER_QUESTION },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: SHELL_TOOL_USE_ID,
            name: "shell",
            input: { command: "Get-Date" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: SHELL_TOOL_USE_ID, content: shellOutput }],
      },
    ],
    stream: true,
    max_tokens: 32000,
    thinking: { type: "enabled", budget_tokens: 1024 },
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeHttpEvent(): HttpRequestEvent {
  return {
    sessionID: "ses_coexist",
    kind: "chat",
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  };
}

function systemTexts(body: WireBody): string[] {
  return typeof body.system === "string" ? [body.system] : body.system.map((part) => part.text);
}

function toolResultTexts(body: WireBody): string[] {
  const texts: string[] = [];
  for (const message of body.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      if (typeof block.content === "string") texts.push(block.content);
      else for (const item of block.content) texts.push(item.text);
    }
  }
  return texts;
}

function parseWireBody(text: string): WireBody {
  const parsed: WireBody = JSON.parse(text);
  return parsed;
}

describe("coexistence with neighbour plugins (task 1.8)", () => {
  test("neighbours before/after the plugin: the boundary final pass is the last word", async () => {
    const host = createFakeHost();
    const ran = { a: 0, b: 0, c: 0, d: 0 };
    let builtBody = "";

    // (a) context neighbour BEFORE the plugin: pushes a part, then merges the two parts.
    host.register("context", (event) => {
      ran.a += 1;
      event.system.push({ type: "text", text: ROUTER_PART });
      const merged = event.system.map((part) => part.text).join("\n");
      event.system.splice(0, event.system.length, { type: "text", text: merged });
    });
    // (d) http.request neighbour BEFORE the plugin: swaps the request for a streamed one.
    host.register("httpRequest", (event) => {
      ran.d += 1;
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        body: streamOf(builtBody),
        headers: { "x-ticket": "t1", "content-type": "application/json" },
        duplex: "half",
      };
      event.request = new Request(NEIGHBOUR_URL, init);
    });

    const cleanup = await setupWith(host.ports, { years: YEARS }, {}, NOW);

    // (b) context neighbour AFTER the plugin: writes the real year back.
    host.register("context", (event) => {
      ran.b += 1;
      const websearch = event.tools.websearch;
      if (websearch === undefined) throw new Error("websearch tool missing");
      websearch.description = websearch.description.replace(
        /The current year is \d{4}\./,
        LATE_YEAR_SENTENCE,
      );
    });
    // (c) execute.after neighbour AFTER the plugin: appends a real-year date.
    host.register("executeAfter", (event) => {
      ran.c += 1;
      if (event.status !== "completed") return;
      const output = event.result.output;
      if (typeof output !== "string") return;
      event.result = { ...event.result, output: `${output}${LATE_CLOCK_SUFFIX}` };
    });

    expect(host.registrations).toBe(3 + 4);

    const context = await host.fire.context(makeContextEvent());
    const shell = await host.fire.executeAfter(makeShellEvent(PT_BR_GET_DATE_OUTPUT));

    // Hook level: the plugin shifted what was there when it ran...
    expect(context.system).toHaveLength(1);
    const mergedText = context.system[0]?.text ?? "";
    expect(mergedText).toContain("Today's date: Mon Oct 12 2146");
    expect(mergedText).not.toContain("Mon Oct 12 2026");
    expect(mergedText.split("\n")).toContain(ROUTER_LINE);
    expect(outputOf(shell)).toContain("12 de outubro de 2146");
    // ...but the late neighbours (b) and (c) win at the hook level.
    expect(context.tools.websearch?.description).toContain(LATE_YEAR_SENTENCE);
    expect(outputOf(shell).endsWith(LATE_CLOCK_SUFFIX)).toBe(true);

    builtBody = JSON.stringify(buildBody(context, outputOf(shell)));
    const http = await host.fire.httpRequest(makeHttpEvent());

    expect(ran).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    expect(http.request.url).toBe(NEIGHBOUR_URL);
    expect(http.request.method).toBe("POST");
    expect(http.request.headers.get("x-ticket")).toBe("t1");
    expect(http.request.headers.get("content-type")).toBe("application/json");

    const sent = parseWireBody(await http.request.text());
    const system = systemTexts(sent);
    const descriptions = sent.tools.map((tool) => tool.description);
    const results = toolResultTexts(sent);

    for (const text of [...system, ...descriptions, ...results]) {
      expect(text).not.toMatch(REAL_YEAR_TOKEN);
    }
    // The version string survives byte-identical; the late writes are fixed at the boundary.
    expect(system.join("\n").split("\n")).toContain(ROUTER_LINE);
    expect(system.join("\n")).toContain("Today's date: Mon Oct 12 2146");
    expect(descriptions.join("\n")).toContain("The current year is 2146.");
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("12 de outubro de 2146");
    expect(results[0]?.endsWith("\n2146-10-12")).toBe(true);
    // No double shift of what the hooks had already shifted.
    expect(JSON.stringify(sent)).not.toContain("2266");

    await cleanup();
    expect(host.registrations).toBe(4);
  });
});
