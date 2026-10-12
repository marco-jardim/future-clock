// Resumable control-vs-treatment experiment battery (plan §0.7, task 2.3).
// Each invocation runs at most MAX_RUNS_PER_INVOCATION opencode runs, prints a <= 4 KiB summary
// and ends with COMPLETE once every (arm, prompt, n) is done ("COMPLETE (with N failed runs: …)"
// when some run is not ok); whenever nothing is pending it (re)writes runs\summary.json. State
// and runs live in the artifacts directory (outside the repo); the sandbox is recreated before
// every run, and the project is built once per invocation before the first run.
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
export const SUMMARY_FILE = artifactPath("runs", "summary.json");
export const TOTAL_RUNS = ARMS.length * PROMPTS.length * N;

const REPO_ROOT = join(import.meta.dir, "..");
const BUILD_OUTPUT_TAIL_CHARS = 800;

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

/** A recorded run (its run.json) plus the number of dump files found in its dumps dir. */
export interface RecordedRun {
  record: RunRecord;
  dumpCount: number;
}

/** One entry of runs\summary.json. */
export interface SummaryEntry {
  id: string;
  arm: Arm;
  promptId: PromptId;
  n: number;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  tools: string[];
  createdFiles: string[];
  sessionIDs: string[];
  dumpCount: number;
  text: string;
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

/** Dumps directory of a run: runs\<arm>\<promptId>\<n>\dumps. */
export function dumpsDir(run: PlannedRun): string {
  return artifactPath("runs", run.arm, run.promptId, String(run.n), "dumps");
}

/**
 * A run is ok when opencode exited 0, did not time out, reported no errors, and the plugin
 * behaved as expected for the arm: treatment must produce at least one dump, control (no plugin) none.
 */
export function isRunOk(
  arm: Arm,
  exitCode: number,
  errors: readonly string[],
  timedOut: boolean,
  dumpCount: number,
): boolean {
  if (exitCode !== 0 || timedOut || errors.length > 0) return false;
  return arm === "treatment" ? dumpCount >= 1 : dumpCount === 0;
}

/**
 * Summary entries sorted by id (`arm/promptId/n`). `ok` is re-evaluated with isRunOk against the
 * current dump count, so records written before the per-arm dump rule are judged the same way.
 */
export function buildSummary(runs: readonly RecordedRun[]): SummaryEntry[] {
  const entries = runs.map(({ record: r, dumpCount }): SummaryEntry => ({
    id: runKey(r.arm, r.promptId, r.n),
    arm: r.arm,
    promptId: r.promptId,
    n: r.n,
    ok: isRunOk(r.arm, r.exitCode, r.errors, r.timedOut, dumpCount),
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    tools: r.toolCalls.map((c) => c.tool),
    createdFiles: [...r.createdFiles],
    sessionIDs: [...r.sessionIDs],
    dumpCount,
    text: r.texts.join("\n"),
  }));
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Final status line: plain COMPLETE, or COMPLETE with the failed run ids (always starts with "COMPLETE"). */
export function completeLine(summary: readonly SummaryEntry[]): string {
  const failed = summary.filter((e) => !e.ok).map((e) => e.id);
  return failed.length === 0 ? "COMPLETE" : `COMPLETE (with ${failed.length} failed runs: ${failed.join(", ")})`;
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

function isArm(v: unknown): v is Arm {
  return ARMS.some((a) => a === v);
}

function isPromptId(v: unknown): v is PromptId {
  return PROMPTS.some((p) => p.id === v);
}

function isToolCall(v: unknown): v is RunResult["toolCalls"][number] {
  return (
    isRecord(v) && typeof v["tool"] === "string" && (v["output"] === undefined || typeof v["output"] === "string")
  );
}

/** Validates a parsed run.json against RunRecord; throws naming the first bad field. */
function parseRunRecord(v: unknown, path: string): RunRecord {
  const bad = (field: string): Error => new Error(`invalid run record (field "${field}"): ${path}`);
  if (!isRecord(v)) throw bad("<root>");
  const { arm, promptId, n, prompt, startedAt, durationMs, exitCode, timedOut, ok } = v;
  const { texts, toolCalls, errors, sessionIDs, createdFiles, opencodeVersion, model } = v;
  if (!isArm(arm)) throw bad("arm");
  if (!isPromptId(promptId)) throw bad("promptId");
  if (typeof n !== "number") throw bad("n");
  if (typeof prompt !== "string") throw bad("prompt");
  if (typeof startedAt !== "string") throw bad("startedAt");
  if (typeof durationMs !== "number") throw bad("durationMs");
  if (typeof exitCode !== "number") throw bad("exitCode");
  if (typeof timedOut !== "boolean") throw bad("timedOut");
  if (typeof ok !== "boolean") throw bad("ok");
  if (!isStringArray(texts)) throw bad("texts");
  if (!Array.isArray(toolCalls) || !toolCalls.every(isToolCall)) throw bad("toolCalls");
  if (!isStringArray(errors)) throw bad("errors");
  if (!isStringArray(sessionIDs)) throw bad("sessionIDs");
  if (!isStringArray(createdFiles)) throw bad("createdFiles");
  if (typeof opencodeVersion !== "string") throw bad("opencodeVersion");
  if (typeof model !== "string") throw bad("model");
  return {
    arm,
    promptId,
    n,
    prompt,
    startedAt,
    durationMs,
    exitCode,
    timedOut,
    ok,
    texts,
    toolCalls,
    errors,
    sessionIDs,
    createdFiles,
    opencodeVersion,
    model,
  };
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

/** Number of dump files in a run's dumps dir (top-level files, as runOpencode lists them); 0 if absent. */
async function countDumps(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: unknown) => {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  });
  return entries === null ? 0 : entries.filter((e) => e.isFile()).length;
}

/** Reads every planned run's run.json (all must exist: called only when nothing is pending). */
async function loadRecordedRuns(): Promise<RecordedRun[]> {
  const out: RecordedRun[] = [];
  for (const run of planRuns([])) {
    const path = join(runDir(run), "run.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if (errorCode(e) === "ENOENT") {
        throw new Error(`state marks ${runKey(run.arm, run.promptId, run.n)} done but ${path} is missing (use --reset to rerun)`);
      }
      throw e;
    }
    out.push({ record: parseRunRecord(JSON.parse(raw), path), dumpCount: await countDumps(dumpsDir(run)) });
  }
  return out;
}

/** Builds the project (`bun scripts/build.ts` from the repo root) so a stale dist is never tested. */
async function runBuild(): Promise<void> {
  const proc = Bun.spawn([process.execPath, "scripts/build.ts"], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const output = `${stdout}${stderr}`.trim().slice(-BUILD_OUTPUT_TAIL_CHARS);
    throw new Error(`build failed (bun scripts/build.ts exited ${code}); aborting so a stale dist is not tested: ${output}`);
  }
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

async function executeRun(run: PlannedRun): Promise<RecordedRun> {
  const prompt = promptText(run.promptId);
  const dir = runDir(run);
  await resetRunDir(dir);
  const cwd = await createSandbox({ arm: run.arm, model: MODEL });
  const dumpDir = dumpsDir(run);
  const startedAt = new Date();
  const result = await runOpencode({ cwd, prompt, isolated: true, dumpDir, model: MODEL, timeoutMs: RUN_TIMEOUT_MS });
  const durationMs = Date.now() - startedAt.getTime();
  const createdFiles = await listCreatedFiles(cwd);
  const dumpCount = await countDumps(dumpDir);
  const record: RunRecord = {
    arm: run.arm,
    promptId: run.promptId,
    n: run.n,
    prompt,
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ok: isRunOk(run.arm, result.exitCode, result.errors, result.timedOut, dumpCount),
    texts: result.texts,
    toolCalls: result.toolCalls,
    errors: result.errors,
    sessionIDs: result.sessionIDs,
    createdFiles,
    opencodeVersion: result.opencodeVersion,
    model: MODEL,
  };
  await writeJsonAtomic(join(dir, "run.json"), record);
  return { record, dumpCount };
}

function recordLine(key: string, { record: r, dumpCount }: RecordedRun): string {
  const head =
    `${key} ${r.ok ? "ok" : "FAIL"} exit=${r.exitCode}${r.timedOut ? " timeout" : ""} ` +
    `${Math.round(r.durationMs / 1000)}s tools=${r.toolCalls.length} errors=${r.errors.length} ` +
    `files=${r.createdFiles.length} dumps=${dumpCount}`;
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
  // Build once per invocation, before any run, so the treatment arm never tests a stale dist.
  if (batch.length > 0) await runBuild();
  const body: string[] = [];
  for (const run of batch) {
    const key = runKey(run.arm, run.promptId, run.n);
    try {
      const recorded = await executeRun(run);
      state.done.push(key);
      await writeJsonAtomic(STATE_FILE, state);
      body.push(recordLine(key, recorded));
    } catch (e) {
      await logException(key, e);
      body.push(`${key} EXCEPTION (not marked done, retried next time): ${oneLine(describe(e), 200)}`);
    }
  }
  const remaining = planRuns(state.done).length;
  const footer = [`progress ${TOTAL_RUNS - remaining}/${TOTAL_RUNS} (runs: ${RUNS_ROOT})`];
  if (remaining === 0) {
    const summary = buildSummary(await loadRecordedRuns());
    await writeJsonAtomic(SUMMARY_FILE, summary);
    footer.push(`summary: ${SUMMARY_FILE}`, completeLine(summary));
  }
  console.log(clipSummary(body, footer, SUMMARY_LIMIT_BYTES));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(oneLine(describe(e), 1000));
    process.exit(1);
  });
}
