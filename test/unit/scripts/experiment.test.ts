import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { ARMS, N, PROMPTS } from "../../../scripts/experiment-prompts";
import {
  ERROR_LOG,
  RUNS_ROOT,
  STATE_FILE,
  TOTAL_RUNS,
  clipSummary,
  planRuns,
  runDir,
  runKey,
} from "../../../scripts/experiment";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

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
});
