// Spawns `opencode run --standalone --format json` and parses its JSONL event stream.
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { ARTIFACTS, artifactPath } from "./artifacts";
import { runEnv } from "./isolation";

export const DEFAULT_MODEL = "opencode-go/claude-haiku-5-5";
export const DEFAULT_TIMEOUT_MS = 300_000;

export interface RunOptions {
  cwd: string;
  prompt: string;
  isolated: boolean;
  dumpDir: string;
  model?: string;
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  texts: string[];
  toolCalls: Array<{ tool: string; input: unknown; output?: string }>;
  errors: string[];
  sessionIDs: string[];
  dumps: string[];
  opencodeVersion: string;
}

type ParsedOutput = Pick<RunResult, "texts" | "toolCalls" | "errors" | "sessionIDs">;
type ToolCall = RunResult["toolCalls"][number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // non-JSON line (log noise): ignored by the caller
  }
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error["message"] === "string") return error["message"];
    const data = error["data"];
    if (isRecord(data) && typeof data["message"] === "string") return data["message"];
  }
  return asText(error);
}

function toolCall(part: Record<string, unknown>): ToolCall | undefined {
  const tool = part["tool"];
  if (typeof tool !== "string") return undefined;
  const state = isRecord(part["state"]) ? part["state"] : {};
  const call: ToolCall = { tool, input: state["input"] };
  const output = state["output"];
  if (output !== undefined && output !== null) call.output = asText(output);
  return call;
}

/** Argv for a run: always --standalone (service mode is not isolated). */
export function buildArgv(model: string, prompt: string, opencodePath: string): string[] {
  return [opencodePath, "run", "--standalone", "--auto", "--format", "json", "-m", model, prompt];
}

/** Parses opencode's JSONL stdout; non-JSON or unknown lines are skipped. */
export function parseRunOutput(stdout: string): ParsedOutput {
  const out: ParsedOutput = { texts: [], toolCalls: [], errors: [], sessionIDs: [] };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const event = parseLine(line);
    if (!isRecord(event)) continue;
    const sessionID = event["sessionID"];
    if (typeof sessionID === "string" && sessionID.length > 0 && !out.sessionIDs.includes(sessionID)) {
      out.sessionIDs.push(sessionID);
    }
    const part = isRecord(event["part"]) ? event["part"] : undefined;
    switch (event["type"]) {
      case "text":
        if (part !== undefined && typeof part["text"] === "string") out.texts.push(part["text"]);
        break;
      case "tool_use": {
        const call = part === undefined ? undefined : toolCall(part);
        if (call !== undefined) out.toolCalls.push(call);
        break;
      }
      case "error":
        out.errors.push(errorMessage(event["error"]));
        break;
      default:
        break;
    }
  }
  return out;
}

function findOpencode(): string {
  const path = Bun.which("opencode");
  if (path === null) throw new Error("opencode not found on PATH");
  return path;
}

let versionCache: Promise<string> | undefined;

/** `opencode --version`, cached per process. */
export function getOpencodeVersion(opencodePath: string = findOpencode()): Promise<string> {
  versionCache ??= (async () => {
    const proc = Bun.spawn([opencodePath, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`opencode --version failed (${code}): ${stderr.slice(0, 300)}`);
    return stdout.trim();
  })();
  return versionCache;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rel = win32.relative(win32.resolve(root), win32.resolve(target));
  return rel === "" || !(rel === ".." || rel.startsWith("..\\") || win32.isAbsolute(rel));
}

async function listDumps(dumpDir: string): Promise<string[]> {
  const entries = await readdir(dumpDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
    .map((name) => join(dumpDir, name));
}

async function recordSessions(sessionIDs: string[]): Promise<void> {
  if (sessionIDs.length === 0) return;
  await mkdir(ARTIFACTS, { recursive: true });
  await appendFile(artifactPath("sessions.txt"), sessionIDs.map((id) => `${id}\n`).join(""));
}

/** Runs one opencode prompt in `cwd`; kills the process after `timeoutMs` (default 300 s). */
export async function runOpencode(o: RunOptions): Promise<RunResult> {
  if (!win32.isAbsolute(o.dumpDir) || /^[\\/]{2}/.test(o.dumpDir)) {
    throw new Error(`dumpDir must be an absolute local path: ${o.dumpDir}`);
  }
  if (isInsideOrEqual(o.cwd, o.dumpDir)) throw new Error(`dumpDir must be outside the run cwd: ${o.dumpDir}`);
  await mkdir(o.dumpDir, { recursive: true });

  const opencode = findOpencode();
  const opencodeVersion = await getOpencodeVersion(opencode);
  const argv = buildArgv(o.model ?? DEFAULT_MODEL, o.prompt, opencode);
  const proc = Bun.spawn(argv, {
    cwd: o.cwd,
    env: runEnv({ isolated: o.isolated, dumpDir: o.dumpDir, cwd: o.cwd }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));

  const parsed = parseRunOutput(stdout);
  await recordSessions(parsed.sessionIDs);
  const dumps = await listDumps(o.dumpDir);
  return { exitCode, timedOut, stdout, stderr, ...parsed, dumps, opencodeVersion };
}
