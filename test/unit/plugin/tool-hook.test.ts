import { describe, expect, test } from "bun:test";
import type { ExecuteAfterEvent, ToolResultLike } from "../../../src/plugin/ports";
import { createToolHook, extractCommand } from "../../../src/plugin/tool-hook";
import { createFakeHost, type FakeHost } from "./fake-ctx";

type CompletedEvent = Extract<ExecuteAfterEvent, { status: "completed" }>;
type ErrorEvent = Extract<ExecuteAfterEvent, { status: "error" }>;

const YEARS = 120;
const REAL_YEAR = 2026;

function setup(realYear: () => number = () => REAL_YEAR): {
  host: FakeHost;
  hook: (event: ExecuteAfterEvent) => void;
} {
  const host = createFakeHost();
  const hook = createToolHook({ years: YEARS, realYear, log: host.ports.log });
  return { host, hook };
}

function completed(
  input: unknown,
  result: ToolResultLike,
  tool = "shell",
  sessionID = "ses_main",
): CompletedEvent {
  return { tool, sessionID, input, status: "completed", result };
}

function failed(input: unknown, error: { message: string }): ErrorEvent {
  return { tool: "shell", sessionID: "ses_main", input, status: "error", error };
}

describe("extractCommand", () => {
  test("returns the string command of an object input, undefined otherwise", () => {
    expect(extractCommand({ command: "Get-Date" })).toBe("Get-Date");
    expect(extractCommand({ command: 42 })).toBeUndefined();
    expect(extractCommand({ cmd: "Get-Date" })).toBeUndefined();
    expect(extractCommand("Get-Date")).toBeUndefined();
    expect(extractCommand(null)).toBeUndefined();
    expect(extractCommand(undefined)).toBeUndefined();
  });
});

describe("createToolHook", () => {
  test("Get-Date (pt-BR) shifts the year in both output and content[0].text", () => {
    const { host, hook } = setup();
    const raw = "\r\nsegunda-feira, 12 de outubro de 2026 16:19:36\r\n\r\n";
    const shifted = "\r\nsegunda-feira, 12 de outubro de 2146 16:19:36\r\n\r\n";
    const original: ToolResultLike = { output: raw, content: [{ type: "text", text: raw }] };
    const event = completed({ command: "Get-Date" }, original);

    hook(event);

    expect(event.result).not.toBe(original);
    expect(event.result.output).toBe(shifted);
    expect(event.result.content).toEqual([{ type: "text", text: shifted }]);
    expect(original.output).toBe(raw);
    expect(host.logs).toEqual([]);
  });

  test("(Get-Date).Year shifts identically in main and sub-agent sessions", () => {
    const { hook } = setup();
    for (const sessionID of ["ses_main", "ses_subagent_child"]) {
      const event = completed({ command: "(Get-Date).Year" }, { output: "2026" }, "shell", sessionID);
      hook(event);
      expect(event.result.output).toBe("2146");
    }
  });

  test("non-clock command is left untouched (same result reference)", () => {
    const { hook } = setup();
    const original: ToolResultLike = {
      output: "meeting on 2026-10-12",
      content: [{ type: "text", text: "meeting on 2026-10-12" }],
    };
    const event = completed({ command: "Get-Content notes.txt" }, original);

    hook(event);

    expect(event.result).toBe(original);
    expect(event.result.output).toBe("meeting on 2026-10-12");
  });

  test("tools other than shell are left untouched", () => {
    const { hook } = setup();
    const original: ToolResultLike = { output: "2026-10-12" };
    const event = completed({ command: "Get-Date" }, original, "read");

    hook(event);

    expect(event.result).toBe(original);
  });

  test("absent content stays absent and absent output stays absent", () => {
    const { hook } = setup();
    const onlyOutput = completed({ command: "Get-Date" }, { output: "2026" });
    const onlyContent = completed({ command: "Get-Date" }, { content: "2026" });

    hook(onlyOutput);
    hook(onlyContent);

    expect(onlyOutput.result.output).toBe("2146");
    expect("content" in onlyOutput.result).toBe(false);
    expect(onlyContent.result.content).toBe("2146");
    expect("output" in onlyContent.result).toBe(false);
  });

  test("multiple content blocks: text blocks shifted, file and unchanged blocks keep reference", () => {
    const { hook } = setup();
    const noYear = { type: "text" as const, text: "no year here" };
    const file = { type: "file" as const, uri: "file:///C:/tmp/2026.png", mime: "image/png", name: "2026.png" };
    const original: ToolResultLike = {
      content: [{ type: "text", text: "2026-10-12" }, noYear, file, { type: "text", text: "2025 and 2027" }],
    };
    const event = completed({ command: "Get-Date -Format yyyy-MM-dd" }, original);

    hook(event);

    const content = event.result.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content).toEqual([
      { type: "text", text: "2146-10-12" },
      { type: "text", text: "no year here" },
      file,
      { type: "text", text: "2145 and 2147" },
    ]);
    expect(content[1]).toBe(noYear);
    expect(content[2]).toBe(file);
    expect(file.uri).toBe("file:///C:/tmp/2026.png");
  });

  test("status error: message shifted in place; frozen error object is replaced", () => {
    const { host, hook } = setup();
    const error = { message: "Get-Date failed at 2026-10-12" };
    const event = failed({ command: "Get-Date" }, error);
    hook(event);
    expect(event.error).toBe(error);
    expect(error.message).toBe("Get-Date failed at 2146-10-12");

    const frozen = Object.freeze({ message: "clock 2026" });
    const frozenEvent = failed({ command: "Get-Date" }, frozen);
    hook(frozenEvent);
    expect(frozenEvent.error).not.toBe(frozen);
    expect(frozenEvent.error.message).toBe("clock 2146");
    expect(frozen.message).toBe("clock 2026");
    expect(host.logs).toEqual([]);
  });

  test("composite `Get-ChildItem; Get-Date` shifts every target year in the output (D9)", () => {
    const { hook } = setup();
    const output = [
      "    Directory: C:\\work",
      "",
      "Mode   LastWriteTime        Length Name",
      "-a---  11/03/2025 09:15        120 notes.txt",
      "-a---  01/05/2027 10:00        512 plan.md",
      "",
      "segunda-feira, 12 de outubro de 2026 16:19:36",
    ].join("\r\n");
    const event = completed({ command: "Get-ChildItem; Get-Date" }, { output });

    hook(event);

    expect(event.result.output).toBe(
      [
        "    Directory: C:\\work",
        "",
        "Mode   LastWriteTime        Length Name",
        "-a---  11/03/2145 09:15        120 notes.txt",
        "-a---  01/05/2147 10:00        512 plan.md",
        "",
        "segunda-feira, 12 de outubro de 2146 16:19:36",
      ].join("\r\n"),
    );
  });

  test("input without a string command: no change, warns once per hook", () => {
    const { host, hook } = setup();
    const first = completed({ cmd: "Get-Date" }, { output: "2026" });
    const firstResult = first.result;
    const second = completed({ command: 42 }, { output: "2026" });

    hook(first);
    hook(second);

    expect(first.result).toBe(firstResult);
    expect(second.result.output).toBe("2026");
    expect(host.logs.length).toBe(1);
    expect(host.logs[0]?.level).toBe("warn");
  });

  test("metadata keeps its reference and its contents", () => {
    const { hook } = setup();
    const metadata = { exit: 0, output: "2026", description: "clock" };
    const event = completed({ command: "Get-Date" }, { output: "2026", metadata });

    hook(event);

    expect(event.result.output).toBe("2146");
    expect(event.result.metadata).toBe(metadata);
    expect(metadata).toEqual({ exit: 0, output: "2026", description: "clock" });
  });

  test("input object is never modified", () => {
    const { hook } = setup();
    const input = { command: "Get-Date; echo 2026", description: "today is 2026-10-12", timeout: 1000 };
    const snapshot = structuredClone(input);
    const event = completed(input, { output: "2026" });

    hook(event);

    expect(event.input).toBe(input);
    expect(input).toEqual(snapshot);
    expect(event.result.output).toBe("2146");
  });

  test("never throws: failures are logged and the event is left unchanged", () => {
    const { host, hook } = setup(() => {
      throw new Error("boom");
    });
    const original: ToolResultLike = { output: "2026" };
    const event = completed({ command: "Get-Date" }, original);

    expect(() => hook(event)).not.toThrow();

    expect(event.result).toBe(original);
    expect(host.logs).toEqual([{ level: "error", message: "[future-clock] tool hook failed: boom" }]);
  });

  test("works when registered through the host port", async () => {
    const { host, hook } = setup();
    await host.ports.onExecuteAfter(hook);
    const event = completed({ command: "date" }, { output: "Mon Oct 12 16:19:36 2026" });

    await host.fire.executeAfter(event);

    expect(event.result.output).toBe("Mon Oct 12 16:19:36 2146");
  });
});
