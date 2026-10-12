// E2E gate: builds the project (`bun scripts/build.ts`, aborting on failure so a stale dist is never
// tested), then runs `bun test ./test/e2e` once with FUTURE_E2E=1 (e2e tests skip without it).
// Not resumable: a single invocation. The full bun test output (stdout+stderr, in order) goes to
// artifacts\state\e2e-<ms>.log; only a <= 4 KiB summary (fail/pass lines + totals) and the log path
// are printed. Exits with bun test's exit code and prints COMPLETE on success.
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { artifactPath } from "./lib/artifacts";

const REPO_ROOT = join(import.meta.dir, "..");
const SUMMARY_LIMIT_BYTES = 4096;
const BUILD_OUTPUT_TAIL_CHARS = 800;
const MAX_ERROR_LINES = 20;
const MAX_LINE_CHARS = 300;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const RESULT_LINE = /^\s*(\((pass|fail|skip|todo)\)|✓|✗)/;
const FAIL_LINE = /^\s*(\(fail\)|✗)/;
const TOTAL_LINE = /^\s*(\d+ (pass|fail|skip|todo|snapshots?|expect\(\) calls?)\b|Ran \d+ tests?\b)/;
const ERROR_LINE = /^\s*error:/;

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function clipLine(s: string): string {
  const t = s.trim();
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t;
}

/** Joins `body` then `footer` lines, dropping body lines (with a marker) so the result fits `limitBytes`. */
function clipSummary(body: readonly string[], footer: readonly string[], limitBytes: number): string {
  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
  const tail = footer.join("\n");
  const marker = "… (summary truncated, see log)";
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

/** Short summary of a bun test run: fail lines, first error lines, other result lines, then totals. */
function summarize(output: string, logPath: string, exitCode: number): string {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  const fails = lines.filter((l) => FAIL_LINE.test(l)).map(clipLine);
  const errors = lines.filter((l) => ERROR_LINE.test(l)).slice(0, MAX_ERROR_LINES).map(clipLine);
  const others = lines.filter((l) => RESULT_LINE.test(l) && !FAIL_LINE.test(l)).map(clipLine);
  const totals = lines.filter((l) => TOTAL_LINE.test(l)).map(clipLine);
  const footer = [...totals, `log: ${logPath}`, exitCode === 0 ? "COMPLETE" : `FAILED (bun test exited ${exitCode})`];
  return clipSummary([...fails, ...errors, ...others], footer, SUMMARY_LIMIT_BYTES);
}

/** Builds the project (`bun scripts/build.ts` from the repo root); throws on failure. */
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

/** Runs bun test with stdout and stderr both written to `logPath` (same fd, so lines stay in order). */
async function runTests(logPath: string): Promise<number> {
  await mkdir(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "w");
  try {
    const proc = Bun.spawn([process.execPath, "test", "./test/e2e"], {
      cwd: REPO_ROOT,
      env: { ...process.env, FUTURE_E2E: "1" },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    return await proc.exited;
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<number> {
  await runBuild();
  const logPath = artifactPath("state", `e2e-${Date.now()}.log`);
  const code = await runTests(logPath);
  console.log(summarize(await readFile(logPath, "utf8"), logPath, code));
  return code;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(describe(e));
      process.exit(1);
    },
  );
}
