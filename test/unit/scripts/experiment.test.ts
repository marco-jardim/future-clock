import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { ARMS, N, PROMPTS } from "../../../scripts/experiment-prompts";
import type { PromptId } from "../../../scripts/experiment-prompts";
import {
  ERROR_LOG,
  RUNS_ROOT,
  STATE_FILE,
  SUMMARY_FILE,
  TOTAL_RUNS,
  buildSummary,
  clipSummary,
  completeLine,
  dumpsDir,
  isRunOk,
  planRuns,
  runDir,
  runKey,
  type RunRecord,
} from "../../../scripts/experiment";
import type { Arm } from "../../../scripts/sandbox";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function record(arm: Arm, promptId: PromptId, n: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    arm,
    promptId,
    n,
    prompt: "p",
    startedAt: "2026-10-12T00:00:00.000Z",
    durationMs: 1234,
    exitCode: 0,
    timedOut: false,
    ok: true,
    texts: [],
    toolCalls: [],
    errors: [],
    sessionIDs: [],
    createdFiles: [],
    opencodeVersion: "2.0.27",
    model: "m",
    ...over,
  };
}

function isInsideRepo(p: string): boolean {
  const rel = relative(REPO_ROOT, p);
  return rel === "" || !(rel.startsWith("..") || /^[A-Za-z]:/.test(rel));
}

describe("experiment plan", () => {
  test("PROMPTS has 8 unique ids; 2 arms x N=2 -> 32 runs", () => {
    expect(PROMPTS.length).toBe(8);
    expect(new Set(PROMPTS.map((p) => p.id)).size).toBe(8);
    expect(ARMS).toEqual(["control", "treatment"]);
    expect(N).toBe(2);
    expect(TOTAL_RUNS).toBe(32);
  });

  test("runKey is arm/prompt/n", () => {
    expect(runKey("control", "P1", 1)).toBe("control/P1/1");
    expect(runKey("treatment", "P8", 2)).toBe("treatment/P8/2");
  });

  test("planRuns plans 32 runs interleaving arms per prompt/n and skips done keys (resume)", () => {
    const all = planRuns([]);
    expect(all.length).toBe(32);
    expect(new Set(all.map((r) => runKey(r.arm, r.promptId, r.n))).size).toBe(32);
    expect(all.slice(0, 4).map((r) => runKey(r.arm, r.promptId, r.n))).toEqual([
      "control/P1/1",
      "treatment/P1/1",
      "control/P1/2",
      "treatment/P1/2",
    ]);
    expect(all.at(-1)).toEqual({ arm: "treatment", promptId: "P8", n: 2 });

    const done = all.slice(0, 8).map((r) => runKey(r.arm, r.promptId, r.n));
    const rest = planRuns(done);
    expect(rest.length).toBe(24);
    expect(rest[0]).toEqual({ arm: "control", promptId: "P3", n: 1 });
    expect(rest.some((r) => done.includes(runKey(r.arm, r.promptId, r.n)))).toBe(false);
    expect(planRuns(all.map((r) => runKey(r.arm, r.promptId, r.n)))).toEqual([]);
  });

  test("state, errors and run dirs live outside the repo; summary stays within the byte limit", () => {
    const paths = [STATE_FILE, ERROR_LOG, RUNS_ROOT, ...planRuns([]).map(runDir)];
    for (const p of paths) expect(isInsideRepo(p)).toBe(false);
    expect(runDir({ arm: "control", promptId: "P4", n: 2 })).toBe(join(RUNS_ROOT, "control", "P4", "2"));

    const body = Array.from({ length: 200 }, (_, i) => `control/P1/1 FAIL ${"é".repeat(40)} ${i}`);
    const out = clipSummary(body, ["progress 32/32", "COMPLETE"], 4096);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
    expect(out.endsWith("progress 32/32\nCOMPLETE")).toBe(true);
    expect(out).toContain("summary truncated");
  });

  test("summary.json and dumps dirs live in the runs artifacts dir", () => {
    expect(isInsideRepo(SUMMARY_FILE)).toBe(false);
    expect(SUMMARY_FILE).toBe(join(RUNS_ROOT, "summary.json"));
    expect(dumpsDir({ arm: "treatment", promptId: "P2", n: 1 })).toBe(join(RUNS_ROOT, "treatment", "P2", "1", "dumps"));
  });
});

describe("isRunOk", () => {
  test("treatment needs >= 1 dump; control (no plugin) needs exactly 0", () => {
    expect(isRunOk("treatment", 0, [], false, 1)).toBe(true);
    expect(isRunOk("treatment", 0, [], false, 5)).toBe(true);
    expect(isRunOk("treatment", 0, [], false, 0)).toBe(false);
    expect(isRunOk("control", 0, [], false, 0)).toBe(true);
    expect(isRunOk("control", 0, [], false, 1)).toBe(false);
  });

  test("non-zero exit, errors or timeout fail regardless of dumps", () => {
    for (const arm of ["control", "treatment"] as const) {
      const dumps = arm === "treatment" ? 1 : 0;
      expect(isRunOk(arm, 1, [], false, dumps)).toBe(false);
      expect(isRunOk(arm, 0, ["boom"], false, dumps)).toBe(false);
      expect(isRunOk(arm, 0, [], true, dumps)).toBe(false);
    }
  });
});

describe("buildSummary", () => {
  test("maps run records to entries sorted by id", () => {
    const summary = buildSummary([
      {
        record: record("treatment", "P2", 1, {
          durationMs: 42,
          texts: ["hello", "world"],
          toolCalls: [
            { tool: "bash", input: { command: "date" }, output: "x" },
            { tool: "write", input: {} },
          ],
          sessionIDs: ["ses_1"],
          createdFiles: ["a.txt", "dir/b.txt"],
        }),
        dumpCount: 3,
      },
      { record: record("control", "P2", 1), dumpCount: 0 },
      { record: record("control", "P1", 2), dumpCount: 0 },
    ]);
    expect(summary.map((e) => e.id)).toEqual(["control/P1/2", "control/P2/1", "treatment/P2/1"]);
    expect(summary[2]).toEqual({
      id: "treatment/P2/1",
      arm: "treatment",
      promptId: "P2",
      n: 1,
      ok: true,
      exitCode: 0,
      durationMs: 42,
      tools: ["bash", "write"],
      createdFiles: ["a.txt", "dir/b.txt"],
      sessionIDs: ["ses_1"],
      dumpCount: 3,
      text: "hello\nworld",
    });
    expect(buildSummary([])).toEqual([]);
  });

  test("ok is re-evaluated per arm from the dump count, exit code, errors and timeout", () => {
    const summary = buildSummary([
      { record: record("treatment", "P1", 1, { ok: true }), dumpCount: 0 },
      { record: record("control", "P1", 1, { ok: true }), dumpCount: 2 },
      { record: record("control", "P1", 2, { exitCode: 1, ok: false }), dumpCount: 0 },
      { record: record("treatment", "P1", 2, { ok: true }), dumpCount: 1 },
    ]);
    const ok = Object.fromEntries(summary.map((e) => [e.id, e.ok]));
    expect(ok).toEqual({
      "control/P1/1": false,
      "control/P1/2": false,
      "treatment/P1/1": false,
      "treatment/P1/2": true,
    });
  });

  test("completeLine lists failed ids and always starts with COMPLETE", () => {
    const allOk = buildSummary([
      { record: record("control", "P1", 1), dumpCount: 0 },
      { record: record("treatment", "P1", 1), dumpCount: 1 },
    ]);
    expect(completeLine(allOk)).toBe("COMPLETE");
    const someFailed = buildSummary([
      { record: record("treatment", "P3", 1), dumpCount: 0 },
      { record: record("control", "P1", 1), dumpCount: 0 },
      { record: record("control", "P2", 2, { timedOut: true }), dumpCount: 0 },
    ]);
    const line = completeLine(someFailed);
    expect(line).toBe("COMPLETE (with 2 failed runs: control/P2/2, treatment/P3/1)");
    expect(line.startsWith("COMPLETE")).toBe(true);
  });
});
