import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISOLATION_XDG_CONFIG, SANDBOX } from "../../../scripts/lib/artifacts";
import { runEnv } from "../../../scripts/lib/isolation";
import {
  type VersionSpawner,
  buildArgv,
  clearOpencodeVersionCache,
  getOpencodeVersion,
  parseRunOutput,
  sessionIDsFromDumps,
  unionIDs,
} from "../../../scripts/lib/opencode-run";
import { PLUGIN_DIR, assertIsSandbox, refuseLink, sandboxConfig } from "../../../scripts/sandbox";

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

  test("printLogs adds --print-logs --log-level warn right after --standalone", () => {
    expect(buildArgv("m/x", "p", "C:\\bin\\opencode.exe", true)).toEqual([
      "C:\\bin\\opencode.exe",
      "run",
      "--standalone",
      "--print-logs",
      "--log-level",
      "warn",
      "--auto",
      "--format",
      "json",
      "-m",
      "m/x",
      "p",
    ]);
    expect(buildArgv("m/x", "p", "o", false)).not.toContain("--print-logs");
  });
});

describe("session IDs", () => {
  test("sessionIDsFromDumps parses ses_<id>-<kind>-<n>.json names only, unique, in order", () => {
    const dir = "C:\\tmp\\dumps";
    expect(
      sessionIDsFromDumps([
        join(dir, "ses_parent1-system-1.json"),
        join(dir, "ses_child2-messages-3.json"),
        join(dir, "ses_parent1-messages-2.json"),
        join(dir, "notes.txt"),
        join(dir, "ses_bad-Upper-1.json"),
        join(dir, "ses_x-system-1.json.bak"),
        join(dir, "xses_y-system-1.json"),
      ]),
    ).toEqual(["ses_parent1", "ses_child2"]);
  });

  test("unionIDs keeps stdout order first and adds child sessions from dumps", () => {
    expect(unionIDs(["ses_parent1"], ["ses_parent1", "ses_child2"])).toEqual(["ses_parent1", "ses_child2"]);
    expect(unionIDs([], [])).toEqual([]);
  });
});

describe("getOpencodeVersion", () => {
  afterEach(() => clearOpencodeVersionCache());

  test("a failed lookup is not cached; a successful one is", async () => {
    clearOpencodeVersionCache();
    let calls = 0;
    const failing: VersionSpawner = () => {
      calls += 1;
      return Promise.reject(new Error("spawn failed"));
    };
    const ok: VersionSpawner = () => {
      calls += 1;
      return Promise.resolve("1.2.3");
    };
    await expect(getOpencodeVersion("C:\\bin\\opencode.exe", failing)).rejects.toThrow("spawn failed");
    expect(await getOpencodeVersion("C:\\bin\\opencode.exe", ok)).toBe("1.2.3");
    expect(await getOpencodeVersion("C:\\bin\\opencode.exe", failing)).toBe("1.2.3");
    expect(calls).toBe(2);
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

  const cwd = "D:\\future-sandbox";

  test("isolated: sets XDG_CONFIG_HOME to the isolation root and FUTURE_CLOCK_DUMP_DIR", () => {
    const env = runEnv({ isolated: true, dumpDir: "C:\\tmp\\dumps", cwd }, inherited);
    expect(env["XDG_CONFIG_HOME"]).toBe(ISOLATION_XDG_CONFIG);
    expect(env["FUTURE_CLOCK_DUMP_DIR"]).toBe("C:\\tmp\\dumps");
    expect(env["OPENCODE_CONFIG_DIR"]).toBeUndefined();
    expect(env["PATH"]).toBe("C:\\bin");
    expect(env["PWD"]).toBe(cwd);
    expect("UNDEF" in env).toBe(false);
  });

  test("non-isolated: removes inherited XDG_CONFIG_HOME/OPENCODE_CONFIG_DIR (any case)", () => {
    const env = runEnv(
      { isolated: false, dumpDir: "C:\\tmp\\dumps", cwd },
      { ...inherited, Xdg_Config_Home: "C:\\x" },
    );
    for (const key of Object.keys(env)) {
      expect(["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"]).not.toContain(key.toUpperCase());
    }
    expect(env["FUTURE_CLOCK_DUMP_DIR"]).toBe("C:\\tmp\\dumps");
    expect(env["PATH"]).toBe("C:\\bin");
  });

  test("drops parent-process vars (INIT_CWD/PWD/OLDPWD/npm_*/NODE/NODE_ENV/OPENCODE*, any case); PWD = cwd", () => {
    const parent = {
      PATH: "C:\\bin",
      SystemRoot: "C:\\Windows",
      INIT_CWD: "D:\\git\\future-agents",
      Init_Cwd: "D:\\git\\future-agents",
      PWD: "D:\\git\\future-agents",
      pwd: "D:\\git\\future-agents",
      OLDPWD: "D:\\git",
      npm_config_local_prefix: "D:\\git\\future-agents",
      NPM_CONFIG_LOCAL_PREFIX: "D:\\git\\future-agents",
      npm_package_json: "D:\\git\\future-agents\\package.json",
      npm_lifecycle_event: "test:e2e",
      npm_lifecycle_script: "bun test test/e2e",
      npm_execpath: "C:\\bun\\bun.exe",
      NODE: "C:\\bun\\node.exe",
      Node_Env: "test",
      OPENCODE: "1",
      OPENCODE_SESSION_ID: "ses_parent",
      OPENCODE_BINARY: "C:\\bin\\opencode.exe",
      OPENCODE_TERMINAL: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OpenCode_Config_Dir: "C:\\elsewhere\\oc",
      FUTURE_CLOCK_DUMP_DIR: "C:\\stale\\dumps",
      NODE_OPTIONS: "--max-old-space-size=4096",
    };
    for (const isolated of [false, true]) {
      const env = runEnv({ isolated, dumpDir: "C:\\tmp\\dumps", cwd }, parent);
      for (const key of Object.keys(env)) {
        const upper = key.toUpperCase();
        expect(["INIT_CWD", "OLDPWD", "NODE", "NODE_ENV"]).not.toContain(upper);
        expect(upper.startsWith("NPM_")).toBe(false);
        expect(upper.startsWith("OPENCODE")).toBe(false);
      }
      expect(Object.keys(env).filter((k) => k.toUpperCase() === "PWD")).toEqual(["PWD"]);
      expect(env["PWD"]).toBe(cwd);
      expect(env["FUTURE_CLOCK_DUMP_DIR"]).toBe("C:\\tmp\\dumps");
      expect(env["PATH"]).toBe("C:\\bin");
      expect(env["SystemRoot"]).toBe("C:\\Windows");
      expect(env["NODE_OPTIONS"]).toBe("--max-old-space-size=4096");
    }
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
    expect(PLUGIN_DIR.toLowerCase()).toBe(join(import.meta.dir, "..", "..", "..", "dist", "future-clock").toLowerCase());
  });
});

describe("refuseLink", () => {
  let base: string;
  let real: string;
  let jn: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "fc-refuse-")));
    real = join(base, "real");
    jn = join(base, "jn");
    await mkdir(join(real, "sub"), { recursive: true });
    await symlink(real, jn, "junction");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("accepts a plain directory (any case on win32) and a missing one", async () => {
    await expect(refuseLink(join(real, "sub"))).resolves.toBeUndefined();
    if (process.platform === "win32") {
      await expect(refuseLink(join(real, "sub").toUpperCase())).resolves.toBeUndefined();
    }
    await expect(refuseLink(join(base, "missing"))).resolves.toBeUndefined();
  });

  test("rejects the junction itself", async () => {
    await expect(refuseLink(jn)).rejects.toThrow("refusing");
  });

  test("rejects a directory reached through a junction higher in the chain", async () => {
    await expect(refuseLink(join(jn, "sub"))).rejects.toThrow("resolves elsewhere");
  });
});
