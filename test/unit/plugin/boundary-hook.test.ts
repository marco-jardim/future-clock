import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoundaryHook, type BoundaryHookDeps } from "../../../src/plugin/boundary-hook";
import type { HttpRequestEvent } from "../../../src/plugin/ports";
import {
  makeOpenAiChatBody,
  makeWireBody,
  PT_BR_GET_DATE_OUTPUT,
  READ_OUTPUT,
  ROLLOVER_TEXT,
  SHELL_TOOL_USE_ID,
  SYSTEM_MAIN_TEXT,
  SYSTEM_ROUTER_TEXT,
  USER_QUESTION,
  WEBSEARCH_DESCRIPTION,
  type WireBody,
} from "../fixtures/wire-body";

const YEARS = 120;
const REAL_YEAR = 2026;
const BRIDGE_URL = "http://127.0.0.1:51234/v1/messages?beta=true";
const BRIDGE_ORIGIN = "http://127.0.0.1:51234";
/** Fake API key, built at runtime so no secret-looking literal is versioned (D13). */
const FAKE_KEY = ["sk", "ant", "x".repeat(24)].join("-");
const KEY_PREFIX = ["sk", "ant", ""].join("-");
const SECRET = `Bearer ${FAKE_KEY}`;
const TICKET = "ticket-7f3e9a1c-bridge";

interface LogEntry {
  level: "warn" | "error";
  message: string;
}

function makeLog(): { entries: LogEntry[]; log: BoundaryHookDeps["log"] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log: (level, message) => {
      entries.push({ level, message });
    },
  };
}

function makeHook(
  overrides: Partial<BoundaryHookDeps> = {},
): { hook: (event: HttpRequestEvent) => Promise<void>; entries: LogEntry[] } {
  const { entries, log } = makeLog();
  const hook = createBoundaryHook({
    years: YEARS,
    realYear: () => REAL_YEAR,
    log,
    enabled: true,
    ...overrides,
  });
  return { hook, entries };
}

function makeEvent(
  body: string | ReadableStream<Uint8Array> | undefined,
  options: { method?: string; headers?: Record<string, string>; url?: string } = {},
): HttpRequestEvent {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  const method = options.method ?? "POST";
  const url = options.url ?? BRIDGE_URL;
  if (body instanceof ReadableStream) {
    const init: RequestInit & { duplex: "half" } = { method, headers, body, duplex: "half" };
    return { sessionID: "ses_abc", kind: "chat", request: new Request(url, init) };
  }
  return { sessionID: "ses_abc", kind: "chat", request: new Request(url, { method, headers, body }) };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17));
      controller.close();
    },
  });
}

/** POST with a streaming body and exactly the given headers (no implicit content-type). */
function makeRawStreamEvent(text: string, headers: Record<string, string>): HttpRequestEvent {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: new Headers(headers),
    body: streamOf(text),
    duplex: "half",
  };
  return { sessionID: "ses_abc", kind: "chat", request: new Request(BRIDGE_URL, init) };
}

/** Minimal Anthropic body: plain "Today's date:" in user/assistant text, a rollover line in a user block. */
function rolloverBodyText(userRolloverBlock: string): string {
  return JSON.stringify({
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "Today's date: 2026-10-12. Plan my week." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Today's date: Mon Oct 12 2026" },
          { type: "text", text: "Today's date is now: Tue Oct 13 2026" },
        ],
      },
      { role: "assistant", content: "Today's date is now: Tue Oct 13 2026" },
      { role: "user", content: [{ type: "text", text: userRolloverBlock }] },
    ],
  });
}

/** Minimal Anthropic body with a classified (Get-Date) and an unclassified shell tool_result. */
function clockToolResultBodyText(): string {
  return JSON.stringify({
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "que dia é hoje?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_clock", name: "shell", input: { command: "Get-Date" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_clock", content: PT_BR_GET_DATE_OUTPUT }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_list", name: "shell", input: { command: "Get-ChildItem" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_list", content: "notes 12 Oct 2026.txt" }],
      },
    ],
  });
}

/** The fixture as it must look after the final pass with years = 120. */
function expectedShiftedBody(): WireBody {
  const body = makeWireBody();
  body.system = [
    {
      type: "text",
      text: SYSTEM_MAIN_TEXT.replace("Today's date: Mon Oct 12 2026", "Today's date: Mon Oct 12 2146"),
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: SYSTEM_ROUTER_TEXT },
  ];
  const websearch = body.tools[0];
  if (websearch === undefined) throw new Error("fixture: websearch tool missing");
  websearch.description = WEBSEARCH_DESCRIPTION.replace("current year is 2026", "current year is 2146");
  body.messages[2] = {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: SHELL_TOOL_USE_ID,
        content: "\r\nsegunda-feira, 12 de outubro de 2146 16:20:00\r\n\r\n",
      },
    ],
  };
  const last = body.messages[4];
  if (last === undefined || typeof last.content === "string") throw new Error("fixture: last message");
  last.content[1] = {
    type: "text",
    text: "Lembrete: prazo em 2026-10-20.\r\nToday's date is now: Tue Oct 13 2146\r\n",
  };
  return body;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "future-clock-boundary-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createBoundaryHook", () => {
  test("rewrites system date line, websearch description, shell output and rollover line only", async () => {
    const { hook, entries } = makeHook();
    const event = makeEvent(JSON.stringify(makeWireBody()));
    const original = event.request;

    await hook(event);

    expect(event.request).not.toBe(original);
    const sent = await event.request.clone().text();
    const expected = expectedShiftedBody();
    expect(sent).toBe(JSON.stringify(expected));

    const parsed: WireBody = JSON.parse(sent);
    expect(parsed.messages[0]?.content).toBe(USER_QUESTION);
    expect(JSON.stringify(parsed.system)).toContain(SYSTEM_ROUTER_TEXT);
    expect(sent).toContain(JSON.stringify(READ_OUTPUT));
    expect(sent).not.toContain(JSON.stringify(PT_BR_GET_DATE_OUTPUT));
    expect(sent).not.toContain(JSON.stringify(ROLLOVER_TEXT));
    expect(entries).toEqual([]);
  });

  test("shifts a shell tool_result whose content is an array of text blocks", async () => {
    const { hook } = makeHook();
    const body = makeWireBody();
    body.messages[2] = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: SHELL_TOOL_USE_ID,
          content: [
            { type: "text", text: PT_BR_GET_DATE_OUTPUT },
            { type: "text", text: "20261012" },
          ],
        },
      ],
    };
    const event = makeEvent(JSON.stringify(body));

    await hook(event);

    const parsed: WireBody = JSON.parse(await event.request.clone().text());
    const message = parsed.messages[2];
    if (message === undefined || typeof message.content === "string") throw new Error("shape");
    const block = message.content[0];
    if (block === undefined || block.type !== "tool_result" || typeof block.content === "string") {
      throw new Error("shape");
    }
    expect(block.content.map((part) => part.text)).toEqual([
      "\r\nsegunda-feira, 12 de outubro de 2146 16:20:00\r\n\r\n",
      "21461012",
    ]);
  });

  test("is idempotent: a second pass leaves the request object and bytes untouched", async () => {
    const { hook } = makeHook();
    const first = makeEvent(JSON.stringify(makeWireBody()));
    await hook(first);
    const firstText = await first.request.clone().text();

    const second: HttpRequestEvent = { sessionID: "ses_abc", kind: "chat", request: first.request };
    await hook(second);

    expect(second.request).toBe(first.request);
    expect(await second.request.clone().text()).toBe(firstText);
  });

  test("leaves an unknown JSON shape untouched and warns once per origin", async () => {
    const { hook, entries } = makeHook();
    const text = JSON.stringify({ input: "Today's date: Mon Oct 12 2026", model: "x" });
    const event = makeEvent(text);
    const original = event.request;

    await hook(event);
    await hook(makeEvent(text));

    expect(event.request).toBe(original);
    expect(await event.request.clone().text()).toBe(text);
    expect(entries.length).toBe(1);
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.message).toContain("unknown shape");
  });

  test("leaves an OpenAI-chat-like body (role 'system' message) untouched and warns unknown shape once (m7)", async () => {
    const { hook, entries } = makeHook();
    const text = JSON.stringify({
      model: "gpt-5",
      messages: [
        { role: "system", content: "Today's date: Mon Oct 12 2026" },
        { role: "user", content: "Today's date is now: Tue Oct 13 2026" },
      ],
    });
    const event = makeEvent(text);
    const original = event.request;

    await hook(event);
    await hook(makeEvent(text));

    expect(event.request).toBe(original);
    expect(await event.request.clone().text()).toBe(text);
    expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
    expect(entries[0]?.message).toContain("unknown shape");
  });

  for (const role of ["system", "tool", "developer"] as const) {
    test(`a message with role '${role}' makes the body an unknown shape, even with a top-level system (m7)`, async () => {
      const { hook, entries } = makeHook();
      const body = { system: "Today's date: Mon Oct 12 2026", ...makeOpenAiChatBody(role) };
      const text = JSON.stringify(body);
      const event = makeEvent(text);
      const original = event.request;

      await hook(event);

      expect(event.request).toBe(original);
      expect(await event.request.clone().text()).toBe(text);
      expect(entries.map((entry) => entry.message)).toEqual([expect.stringContaining("unknown shape")]);
    });
  }

  test("a top-level system that is neither string nor array is an unknown shape (m7)", async () => {
    const { hook, entries } = makeHook();
    const text = JSON.stringify({
      system: { text: "Today's date: Mon Oct 12 2026" },
      messages: [{ role: "user", content: "Today's date is now: Tue Oct 13 2026" }],
    });
    const event = makeEvent(text);
    const original = event.request;

    await hook(event);

    expect(event.request).toBe(original);
    expect(entries.map((entry) => entry.message)).toEqual([expect.stringContaining("unknown shape")]);
  });

  test("an Anthropic body without system is still handled (m7)", async () => {
    const { hook, entries } = makeHook();
    const body: Partial<WireBody> = makeWireBody();
    delete body.system;
    const event = makeEvent(JSON.stringify(body));
    const original = event.request;

    await hook(event);

    expect(event.request).not.toBe(original);
    const expected: Partial<WireBody> = expectedShiftedBody();
    delete expected.system;
    const sent = await event.request.clone().text();
    expect(sent).toBe(JSON.stringify(expected));
    expect(sent).toContain("current year is 2146");
    expect(sent).toContain("Today's date is now: Tue Oct 13 2146");
    expect(entries).toEqual([]);
  });

  test("leaves a non-JSON body untouched and warns", async () => {
    const { hook, entries } = makeHook();
    const text = "Today's date: Mon Oct 12 2026 (not json)";
    const event = makeEvent(text);
    const original = event.request;

    await hook(event);

    expect(event.request).toBe(original);
    expect(await event.request.clone().text()).toBe(text);
    expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
    expect(entries[0]?.message).toContain("not JSON");
  });

  test("not-JSON and unknown-shape warn under separate keys and never quote the body (N7)", async () => {
    const { hook, entries } = makeHook();
    const notJson = `${SECRET} Today's date: Mon Oct 12 2026 {`;
    const byteLength = new TextEncoder().encode(notJson).byteLength;

    await hook(makeEvent(notJson));
    await hook(makeEvent(notJson));
    await hook(makeEvent(JSON.stringify({ input: "x", model: "y" })));
    await hook(makeEvent(JSON.stringify({ input: "x", model: "y" })));

    expect(entries.map((entry) => entry.level)).toEqual(["warn", "warn"]);
    const notJsonMessage = entries[0]?.message ?? "";
    expect(notJsonMessage).toContain("not JSON");
    expect(notJsonMessage).toContain(`(${byteLength} bytes)`);
    expect(notJsonMessage).not.toContain("Bearer");
    expect(notJsonMessage).not.toContain(KEY_PREFIX);
    expect(notJsonMessage).not.toContain("Today");
    expect(entries[1]?.message).toContain("unknown shape");
  });

  test("rewrites only 'Today's date is now:' lines of non-assistant messages (m2, D10)", async () => {
    const { hook, entries } = makeHook();
    const event = makeEvent(rolloverBodyText("x\nToday's date is now: Tue Oct 13 2026"));

    await hook(event);

    expect(await event.request.clone().text()).toBe(
      rolloverBodyText("x\nToday's date is now: Tue Oct 13 2146"),
    );
    expect(entries).toEqual([]);
  });

  test("plain 'Today's date:' in user content and assistant text leaves the request untouched (m2)", async () => {
    const { hook } = makeHook();
    const text = rolloverBodyText("x\nno rollover here: Tue Oct 13 2026");
    const event = makeEvent(text);
    const original = event.request;

    await hook(event);

    expect(event.request).toBe(original);
    expect(await event.request.clone().text()).toBe(text);
  });

  test("skips non-POST requests and content-encoded bodies", async () => {
    const { hook, entries } = makeHook();
    const get = makeEvent(undefined, { method: "GET" });
    const getOriginal = get.request;
    await hook(get);
    expect(get.request).toBe(getOriginal);
    expect(entries).toEqual([]);

    const encoded = makeEvent(JSON.stringify(makeWireBody()), { headers: { "content-encoding": "gzip" } });
    const encodedOriginal = encoded.request;
    await hook(encoded);
    expect(encoded.request).toBe(encodedOriginal);
    expect(entries.map((entry) => entry.level)).toEqual(["warn"]);
    expect(entries[0]?.message).toContain("content-encoding");
  });

  test("reads a streaming body (ReadableStream, duplex half) and the replacement stays readable", async () => {
    const { hook } = makeHook();
    const event = makeEvent(streamOf(JSON.stringify(makeWireBody())));

    await hook(event);

    const bytes = await event.request.clone().arrayBuffer();
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(expectedShiftedBody()));
  });

  test("a streaming body that needs no change keeps the same request and readable bytes (m5)", async () => {
    const { hook, entries } = makeHook();
    const text = JSON.stringify(expectedShiftedBody());
    const event = makeEvent(streamOf(text));
    const original = event.request;

    await hook(event);

    expect(event.request).toBe(original);
    const first = new Uint8Array(await event.request.clone().arrayBuffer());
    const second = new Uint8Array(await event.request.clone().arrayBuffer());
    expect(second).toEqual(first);
    expect(new TextDecoder().decode(first)).toBe(text);
    expect(entries).toEqual([]);
  });

  test("replacement body is binary: no implicit content-type, x-ticket kept (m4)", async () => {
    const { hook } = makeHook();
    const event = makeRawStreamEvent(JSON.stringify(makeWireBody()), { "x-ticket": TICKET });
    const original = event.request;
    expect(original.headers.get("content-type")).toBeNull();

    await hook(event);

    expect(event.request).not.toBe(original);
    expect(event.request.headers.get("content-type")).toBeNull();
    expect(event.request.headers.get("x-ticket")).toBe(TICKET);
    expect(await event.request.clone().text()).toBe(JSON.stringify(expectedShiftedBody()));
  });

  test("replacement drops a copied transfer-encoding header (m4)", async () => {
    const { hook } = makeHook();
    const event = makeRawStreamEvent(JSON.stringify(makeWireBody()), {
      "x-ticket": TICKET,
      "transfer-encoding": "chunked",
    });
    const original = event.request;
    expect(original.headers.get("transfer-encoding")).toBe("chunked");

    await hook(event);

    expect(event.request).not.toBe(original);
    expect(event.request.headers.get("transfer-encoding")).toBeNull();
    expect(event.request.headers.get("x-ticket")).toBe(TICKET);
    expect(await event.request.clone().text()).toBe(JSON.stringify(expectedShiftedBody()));
  });

  test("preserves url, method and unknown headers; drops the stale content-length", async () => {
    const { hook } = makeHook();
    const text = JSON.stringify(makeWireBody());
    // A value that cannot match the rewritten body: it must not be carried over.
    const staleLength = String(new TextEncoder().encode(text).byteLength + 7);
    const event = makeEvent(text, {
      headers: { "x-ticket": TICKET, authorization: SECRET, "content-length": staleLength },
    });

    await hook(event);

    const sent = await event.request.clone().text();
    const sentLength = String(new TextEncoder().encode(sent).byteLength);
    expect(sent).toBe(JSON.stringify(expectedShiftedBody()));
    expect(event.request.url).toBe(BRIDGE_URL);
    expect(event.request.method).toBe("POST");
    expect(event.request.headers.get("x-ticket")).toBe(TICKET);
    expect(event.request.headers.get("authorization")).toBe(SECRET);
    expect(event.request.headers.get("content-type")).toBe("application/json");
    const length = event.request.headers.get("content-length");
    expect(length === null || length === sentLength).toBe(true);
  });

  test("enabled=false never replaces the request but still dumps the original bytes", async () => {
    const dir = await makeTempDir();
    const { hook } = makeHook({ enabled: false, dumpDir: dir });
    const text = JSON.stringify(makeWireBody());
    const event = makeEvent(text);
    const original = event.request;

    await hook(event);

    expect(event.request).toBe(original);
    const files = (await readdir(dir)).sort();
    const bodyFile = files.find((name) => name.endsWith(".json") && !name.endsWith(".l3.json"));
    const l3File = files.find((name) => name.endsWith(".l3.json"));
    if (bodyFile === undefined || l3File === undefined) throw new Error(`dump files missing: ${files.join(",")}`);
    expect(bodyFile).toMatch(/^ses_abc-chat-\d+\.json$/);
    expect(await readFile(join(dir, bodyFile), "utf8")).toBe(text);
    expect(JSON.parse(await readFile(join(dir, l3File), "utf8"))).toEqual({
      changed: 4,
      applied: false,
      origin: BRIDGE_ORIGIN,
      kind: "chat",
    });
  });

  test("dumps the final body and an origin-only summary, never header values", async () => {
    const dir = await makeTempDir();
    const { hook } = makeHook({ dumpDir: dir });
    const event = makeEvent(JSON.stringify(makeWireBody()), {
      headers: { authorization: SECRET, "x-ticket": TICKET },
    });

    await hook(event);

    const sent = await event.request.clone().text();
    const files = await readdir(dir);
    expect(files.length).toBe(2);
    for (const name of files) {
      const content = await readFile(join(dir, name), "utf8");
      expect(content).not.toContain(KEY_PREFIX);
      expect(content).not.toContain(TICKET);
      expect(content.toLowerCase()).not.toContain("authorization");
      expect(content).not.toContain("/v1/messages");
      expect(content).not.toContain("beta=true");
      if (name.endsWith(".l3.json")) {
        expect(JSON.parse(content)).toEqual({ changed: 4, applied: true, origin: BRIDGE_ORIGIN, kind: "chat" });
      } else {
        expect(content).toBe(sent);
      }
    }
  });

  test("a dump write error is logged and never thrown; the rewrite still applies", async () => {
    const dir = await makeTempDir();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const { hook, entries } = makeHook({ dumpDir: join(blocker, "dumps") });
    const event = makeEvent(JSON.stringify(makeWireBody()));
    const original = event.request;

    await hook(event);

    expect(event.request).not.toBe(original);
    expect(await event.request.clone().text()).toBe(JSON.stringify(expectedShiftedBody()));
    expect(entries.map((entry) => entry.level)).toEqual(["error"]);
    expect(entries[0]?.message).toContain("dump write failed");
  });

  test("detector warns once when a date-shaped real year survives in system, tool or shell text", async () => {
    const { hook, entries } = makeHook({ enabled: false });

    await hook(makeEvent(JSON.stringify(makeWireBody())));
    await hook(makeEvent(JSON.stringify(makeWireBody())));

    const warnings = entries.filter((entry) => entry.level === "warn");
    expect(warnings.map((entry) => entry.message)).toEqual([
      expect.stringContaining("real year 2026 still present in date-shaped text of system"),
      expect.stringContaining("real year 2026 still present in date-shaped text of tool:websearch"),
      expect.stringContaining("real year 2026 still present in date-shaped text of tool_result"),
    ]);
  });

  test("detector scans classified shell tool_results and measures before/after the pass (N8)", async () => {
    const disabled = makeHook({ enabled: false });
    const event = makeEvent(clockToolResultBodyText());
    const original = event.request;

    await disabled.hook(event);
    await disabled.hook(makeEvent(clockToolResultBodyText()));

    expect(event.request).toBe(original);
    expect(disabled.entries.map((entry) => entry.level)).toEqual(["warn"]);
    const message = disabled.entries[0]?.message ?? "";
    expect(message).toContain("real year 2026 still present in date-shaped text of tool_result");
    expect(message).toContain("1 left, 1 before");
    expect(message).toContain("enabled=false");

    // Enabled: the real year is found before the pass but none survives in what is sent.
    const enabled = makeHook();
    const shifted = makeEvent(clockToolResultBodyText());
    await enabled.hook(shifted);
    const sent = await shifted.request.clone().text();
    expect(sent).toContain("12 de outubro de 2146");
    expect(sent).toContain("notes 12 Oct 2026.txt");
    expect(enabled.entries).toEqual([]);
  });

  test("never throws: an internal failure is logged and the request is left untouched", async () => {
    const { hook, entries } = makeHook({
      realYear: () => {
        throw new Error("clock unavailable");
      },
    });
    const event = makeEvent(JSON.stringify(makeWireBody()));
    const original = event.request;

    await hook(event);

    expect(event.request).toBe(original);
    expect(entries.map((entry) => entry.level)).toEqual(["error"]);
    expect(entries[0]?.message).toContain("clock unavailable");
  });
});
