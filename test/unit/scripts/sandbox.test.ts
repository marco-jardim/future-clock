import { describe, expect, test } from "bun:test";
import { ISOLATION_XDG_CONFIG, SANDBOX } from "../../../scripts/lib/artifacts";
import { runEnv } from "../../../scripts/lib/isolation";
import { buildArgv, parseRunOutput } from "../../../scripts/lib/opencode-run";
import { PLUGIN_DIR, assertIsSandbox, sandboxConfig } from "../../../scripts/sandbox";

const SAMPLE_JSONL = [
  '{"type":"step_start","timestamp":1,"sessionID":"ses_abc","part":{"type":"step-start"}}',
  '{"type":"tool_use","timestamp":2,"sessionID":"ses_abc","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"Get-Date"},"output":"segunda-feira, 12 de outubro de 2146"}}}',
  '{"type":"text","timestamp":3,"sessionID":"ses_abc","part":{"type":"text","text":"Hoje é 12/10/2146."}}',
  "INFO  2026-10-12 service=plugin not json {",
  "",
  '{"type":"error","timestamp":4,"sessionID":"ses_def","error":{"name":"APIError","message":"boom"}}',
  '{"type":"text","timestamp":5,"sessionID":"ses_abc","part":{"type":"text","text":"OK"}}\r',
].join("\n");

describe("buildArgv", () => {
  test("always runs standalone, json, auto, with model and prompt last", () => {
    expect(buildArgv("m/x", "Que dia é hoje?", "C:\\bin\\opencode.exe")).toEqual([
      "C:\\bin\\opencode.exe",
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "-m",
      "m/x",
      "Que dia é hoje?",
    ]);
  });
});

describe("parseRunOutput", () => {
  test("extracts texts, tool calls, errors and unique sessionIDs; skips garbage", () => {
    const r = parseRunOutput(SAMPLE_JSONL);
    expect(r.texts).toEqual(["Hoje é 12/10/2146.", "OK"]);
    expect(r.toolCalls).toEqual([
      { tool: "bash", input: { command: "Get-Date" }, output: "segunda-feira, 12 de outubro de 2146" },
    ]);
    expect(r.errors).toEqual(["boom"]);
    expect(r.sessionIDs).toEqual(["ses_abc", "ses_def"]);
  });

  test("tool_use without output has no output key; empty input yields empty result", () => {
    const r = parseRunOutput(
      '{"type":"tool_use","sessionID":"s1","part":{"tool":"read","state":{"status":"running","input":{"filePath":"notes.txt"}}}}',
    );
    expect(r.toolCalls).toEqual([{ tool: "read", input: { filePath: "notes.txt" } }]);
    expect(parseRunOutput("")).toEqual({ texts: [], toolCalls: [], errors: [], sessionIDs: [] });
  });
});

describe("runEnv", () => {
  const inherited = {
    PATH: "C:\\bin",
    XDG_CONFIG_HOME: "C:\\elsewhere\\xdg",
    OPENCODE_CONFIG_DIR: "C:\\elsewhere\\oc",
    UNDEF: undefined,
  };

  test("isolated: sets XDG_CONFIG_HOME to the isolation root and FUTURE_CLOCK_DUMP_DIR", () => {
    const env = runEnv({ isolated: true, dumpDir: "C:\\tmp\\dumps" }, inherited);
    expect(env["XDG_CONFIG_HOME"]).toBe(ISOLATION_XDG_CONFIG);
    expect(env["FUTURE_CLOCK_DUMP_DIR"]).toBe("C:\\tmp\\dumps");
    expect(env["OPENCODE_CONFIG_DIR"]).toBeUndefined();
    expect(env["PATH"]).toBe("C:\\bin");
    expect("UNDEF" in env).toBe(false);
  });

  test("non-isolated: removes inherited XDG_CONFIG_HOME/OPENCODE_CONFIG_DIR (any case)", () => {
    const env = runEnv({ isolated: false, dumpDir: "C:\\tmp\\dumps" }, { ...inherited, Xdg_Config_Home: "C:\\x" });
    for (const key of Object.keys(env)) {
      expect(["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"]).not.toContain(key.toUpperCase());
    }
    expect(env["FUTURE_CLOCK_DUMP_DIR"]).toBe("C:\\tmp\\dumps");
    expect(env["PATH"]).toBe("C:\\bin");
  });
});

describe("sandbox", () => {
  test("assertIsSandbox accepts only SANDBOX itself (case-insensitive)", () => {
    for (const bad of ["D:\\", "D:\\future-sandbox\\..\\x", "D:\\future-sandboxx", "D:\\future-sandbox\\sub", "future-sandbox", "\\\\?\\D:\\future-sandbox"]) {
      expect(() => assertIsSandbox(bad)).toThrow();
    }
    expect(assertIsSandbox("d:\\FUTURE-SANDBOX")).toBe(SANDBOX);
    expect(assertIsSandbox(SANDBOX)).toBe(SANDBOX);
  });

  test("sandboxConfig: treatment loads the built plugin dir, control loads none", () => {
    expect(sandboxConfig({ arm: "treatment" })).toEqual({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      model: "opencode-go/claude-haiku-5-5",
      plugins: [{ package: PLUGIN_DIR, options: { years: 120 } }],
    });
    expect(sandboxConfig({ arm: "control", model: "m/y" })["plugins"]).toEqual([]);
    expect(PLUGIN_DIR.toLowerCase()).toBe("d:\\git\\future-agents\\dist\\future-clock");
  });
});
