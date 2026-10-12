// Resumable control-vs-treatment experiment battery (plan §0.7, task 2.3).
// Each invocation runs at most MAX_RUNS_PER_INVOCATION opencode runs, prints a <= 4 KiB summary
// and ends with COMPLETE once every (arm, prompt, n) is done. State and runs live in the
// artifacts directory (outside the repo); the sandbox is recreated before every run.
// Usage: bun scripts/experiment.ts [--reset]   (--reset clears the state, never the runs)
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ARMS, N, PROMPTS, type PromptId } from "./experiment-prompts";
import { artifactPath, assertUnder } from "./lib/artifacts";
import { DEFAULT_MODEL, runOpencode, type RunResult } from "./lib/opencode-run";
import { createSandbox, type Arm } from "./sandbox";

export const MAX_RUNS_PER_INVOCATION = 8;
export const RUN_TIMEOUT_MS = 600_000;
export const SUMMARY_LIMIT_BYTES = 4096;
export const MODEL = DEFAULT_MODEL;
export const RUNS_ROOT = artifactPath("runs");
export const STATE_FILE = artifactPath("state", "experiment.json");
export const ERROR_LOG = artifactPath("state", "experiment-errors.log");
export const TOTAL_RUNS = ARMS.length * PROMPTS.length * N;

/** Top-level sandbox entries created by createSandbox itself (not by the model). */
const SANDBOX_BASELINE = new Set([".git", "opencode.json", "notes.txt"]);
const MAX_CREATED_FILES = 500;

export interface PlannedRun {
  arm: Arm;
  promptId: PromptId;
  n: number;
}

export interface RunRecord {
  arm: Arm;
  promptId: PromptId;
  n: number;
  prompt: string;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  ok: boolean;
  texts: string[];
  toolCalls: RunResult["toolCalls"];
  errors: string[];
  sessionIDs: string[];
  createdFiles: string[];
  opencodeVersion: string;
  model: string;
}

interface State {
  done: string[];
}

/** State key of a run: `${arm}/${promptId}/${n}`. */
export function runKey(arm: Arm, promptId: PromptId, n: number): string {
  return `${arm}/${promptId}/${n}`;
}

/** Pending runs in execution order (per prompt, per n: control then treatment), skipping `done` keys. */
export function planRuns(done: readonly string[]): PlannedRun[] {
  const skip = new Set(done);
  const out: PlannedRun[] = [];
  for (const prompt of PROMPTS) {
    for (let n = 1; n <= N; n++) {
      for (const arm of ARMS) {
        if (!skip.has(runKey(arm, prompt.id, n))) out.push({ arm, promptId: prompt.id, n });
      }
    }
  }
  return out;
}

/** Artifact directory of a run: runs\<arm>\<promptId>\<n>. */
export function runDir(run: PlannedRun): string {
  return artifactPath("runs", run.arm, run.promptId, String(run.n));
}

/** Joins `body` then `footer` lines, dropping body lines (with a marker) so the result fits `limitBytes`. */
export function clipSummary(body: readonly string[], footer: readonly string[], limitBytes: number): string {
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  const tail = footer.join("\n");
  const marker = "… (summary truncated)";
  const kept: string[] = [];
  let used = bytes(tail) + bytes(marker) + 2;
  for (const line of body) {
    const cost = bytes(line) + 1;
    if (used + cost > limitBytes) {
      kept.push(marker);
      break;
    }
    kept.push(line);
    used += cost;
  }
  return [...kept, tail].join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x: unknown) => typeof x === "string");
}

function errorCode(e: unknown): unknown {
  return e instanceof Error ? Reflect.get(e, "code") : undefined;
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function promptText(id: PromptId): string {
  const prompt = PROMPTS.find((p) => p.id === id);
  if (prompt === undefined) throw new Error(`unknown prompt id: ${id}`);
  return prompt.text;
}

async function loadState(): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(STATE_FILE, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return { done: [] };
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isStringArray(parsed["done"])) {
    throw new Error(`invalid state file (expected {done: string[]}): ${STATE_FILE}`);
  }
  return { done: [...parsed["done"]] };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

/** Files under the sandbox not created by createSandbox (relative, "/"-separated, links not followed). */
async function listCreatedFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= MAX_CREATED_FILES) return;
      if (rel === "" && SANDBOX_BASELINE.has(entry.name)) continue;
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relPath);
      else out.push(relPath);
    }
  };
  await walk(root, "");
  return out.sort();
}

/** Clears a previous partial attempt of this run (only inside RUNS_ROOT). */
async function resetRunDir(dir: string): Promise<void> {
  await mkdir(RUNS_ROOT, { recursive: true });
  await rm(await assertUnder(RUNS_ROOT, dir), { recursive: true, force: true });
}

async function executeRun(run: PlannedRun): Promise<RunRecord> {
  const prompt = promptText(run.promptId);
  const dir = runDir(run);
  await resetRunDir(dir);
  const cwd = await createSandbox({ arm: run.arm, model: MODEL });
  const dumpDir = artifactPath("runs", run.arm, run.promptId, String(run.n), "dumps");
  const startedAt = new Date();
  const result = await runOpencode({ cwd, prompt, isolated: true, dumpDir, model: MODEL, timeoutMs: RUN_TIMEOUT_MS });
  const durationMs = Date.now() - startedAt.getTime();
  const createdFiles = await listCreatedFiles(cwd);
  const record: RunRecord = {
    arm: run.arm,
    promptId: run.promptId,
    n: run.n,
    prompt,
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ok: result.exitCode === 0 && !result.timedOut && result.errors.length === 0,
    texts: result.texts,
    toolCalls: result.toolCalls,
    errors: result.errors,
    sessionIDs: result.sessionIDs,
    createdFiles,
    opencodeVersion: result.opencodeVersion,
    model: MODEL,
  };
  await writeJsonAtomic(join(dir, "run.json"), record);
  return record;
}

function recordLine(key: string, r: RunRecord): string {
  const head =
    `${key} ${r.ok ? "ok" : "FAIL"} exit=${r.exitCode}${r.timedOut ? " timeout" : ""} ` +
    `${Math.round(r.durationMs / 1000)}s tools=${r.toolCalls.length} errors=${r.errors.length} files=${r.createdFiles.length}`;
  const firstError = r.errors[0];
  return firstError === undefined ? head : `${head} | ${oneLine(firstError, 160)}`;
}

async function logException(key: string, e: unknown): Promise<void> {
  await mkdir(dirname(ERROR_LOG), { recursive: true });
  const detail = e instanceof Error ? (e.stack ?? describe(e)) : String(e);
  await appendFile(ERROR_LOG, `${new Date().toISOString()} ${key}\n${detail}\n\n`);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--reset")) {
    await rm(STATE_FILE, { force: true });
    console.log(`experiment state reset (runs kept): ${STATE_FILE}`);
    return;
  }
  const state = await loadState();
  const batch = planRuns(state.done).slice(0, MAX_RUNS_PER_INVOCATION);
  const body: string[] = [];
  for (const run of batch) {
    const key = runKey(run.arm, run.promptId, run.n);
    try {
      const record = await executeRun(run);
      state.done.push(key);
      await writeJsonAtomic(STATE_FILE, state);
      body.push(recordLine(key, record));
    } catch (e) {
      await logException(key, e);
      body.push(`${key} EXCEPTION (not marked done, retried next time): ${oneLine(describe(e), 200)}`);
    }
  }
  const remaining = planRuns(state.done).length;
  const footer = [`progress ${TOTAL_RUNS - remaining}/${TOTAL_RUNS} (runs: ${RUNS_ROOT})`];
  if (remaining === 0) footer.push("COMPLETE");
  console.log(clipSummary(body, footer, SUMMARY_LIMIT_BYTES));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(oneLine(describe(e), 1000));
    process.exit(1);
  });
}
