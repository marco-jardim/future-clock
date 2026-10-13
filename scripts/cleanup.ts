// Safe cleanup of the sandbox, the probe directory and temporary artifacts.
// Only the allowlisted targets below are deleted; runs/, dumps/, probe data (except dist),
// sentinels.json and preflight-env.json are preserved.
// Usage: bun run cleanup
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { ARTIFACTS, PROBE_ROOT, SANDBOX, artifactPath, assertUnder } from "./lib/artifacts";
import { assertIsSandbox } from "./sandbox";

const EXPECTED_PROBE_ROOT = "D:\\future-probe";
const RM_TRIES = 5;
const RM_BACKOFF_MS = 500;
/** Transient Windows lock errors while a previous opencode/git process releases the directory. */
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
/** Opencode session id token inside sessions.txt lines. */
const SESSION_ID = /\bses_[A-Za-z0-9]+/g;

/** Deletable subtrees of ARTIFACTS; everything else under ARTIFACTS is kept. */
function artifactTargets(): string[] {
  return [artifactPath("iso"), artifactPath("probe", "dist")];
}

/** The full, fixed list of paths `bun run cleanup` deletes. */
export function cleanupTargets(): string[] {
  return [SANDBOX, PROBE_ROOT, ...artifactTargets()];
}

/** Data that must survive the cleanup (a target may never be one of these nor contain one). */
export function preservedPaths(): string[] {
  return [
    artifactPath("runs"),
    artifactPath("dumps"),
    artifactPath("probe"),
    artifactPath("sentinels.json"),
    artifactPath("preflight-env.json"),
    artifactPath("probe", "sentinels.json"),
    artifactPath("probe", "preflight-env.json"),
  ];
}

function errorCode(e: unknown): unknown {
  return e instanceof Error ? Reflect.get(e, "code") : undefined;
}

function key(p: string): string {
  return win32.resolve(p).toLowerCase();
}

/** Same rule as artifacts.ts: segments made only of dots/spaces may act as "." or ".." on Windows. */
function isDotSegment(segment: string): boolean {
  return segment.includes(".") && /^[. ]+$/.test(segment);
}

/** True when `inner` is `outer` itself or lies below it (case-insensitive, win32 semantics). */
function isSameOrInside(outer: string, inner: string): boolean {
  const rel = win32.relative(win32.resolve(outer), win32.resolve(inner));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel);
}

function assertProbeRoot(p: string): string {
  if (PROBE_ROOT.toLowerCase() !== EXPECTED_PROBE_ROOT.toLowerCase()) {
    throw new Error(`PROBE_ROOT changed unexpectedly: ${PROBE_ROOT}`);
  }
  if (p.toLowerCase() !== EXPECTED_PROBE_ROOT.toLowerCase()) {
    throw new Error(`refusing probe target other than ${EXPECTED_PROBE_ROOT}: ${p}`);
  }
  return PROBE_ROOT;
}

/** Validates one target and returns its canonical path; throws for anything not explicitly allowed. */
async function validateTarget(p: string): Promise<string> {
  if (/^[\\/]{2}/.test(p)) throw new Error(`UNC/device path not allowed: ${p}`);
  if (!/^[A-Za-z]:[\\/]/.test(p)) throw new Error(`path must be absolute: ${p}`);
  if (p.split(/[\\/]/).some(isDotSegment)) throw new Error(`".." or dot-only segment not allowed: ${p}`);
  if (win32.resolve(p) === win32.parse(win32.resolve(p)).root) throw new Error(`refusing drive root: ${p}`);
  const kept = preservedPaths().find((keep) => isSameOrInside(p, keep));
  if (kept !== undefined) throw new Error(`refusing: ${p} is or contains preserved data ${kept}`);

  const k = key(p);
  if (k === key(SANDBOX)) return assertIsSandbox(p);
  if (k === key(PROBE_ROOT)) return assertProbeRoot(p);
  const allowed = artifactTargets().find((a) => key(a) === k);
  if (allowed === undefined) throw new Error(`not an allowed cleanup target: ${p}`);
  await assertUnder(ARTIFACTS, p);
  return allowed;
}

/** Validates every target (all-or-nothing) and returns the canonical, de-duplicated list to delete. */
export async function planCleanup(targets: readonly string[]): Promise<string[]> {
  const plan: string[] = [];
  for (const t of targets) {
    const canonical = await validateTarget(t);
    if (!plan.some((q) => key(q) === key(canonical))) plan.push(canonical);
  }
  return plan;
}

/** Throws if `p` itself is a symlink/junction; returns false when `p` does not exist. */
async function existsAndNotLink(p: string): Promise<boolean> {
  let isLink: boolean;
  try {
    isLink = (await lstat(p)).isSymbolicLink();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
  if (isLink) throw new Error(`refusing: ${p} is a link/junction`);
  // Catches reparse points lstat may not flag: the target's real path must be its real parent + its own name.
  const [realTarget, realParent] = await Promise.all([realpath(p), realpath(win32.dirname(p))]);
  if (key(realTarget) !== key(win32.join(realParent, win32.basename(p)))) {
    throw new Error(`refusing: ${p} resolves elsewhere (${realTarget})`);
  }
  return true;
}

async function removeWithRetry(p: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(p, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = errorCode(e);
      if (attempt >= RM_TRIES || typeof code !== "string" || !RETRYABLE.has(code)) throw e;
      await Bun.sleep(RM_BACKOFF_MS * attempt);
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
}

/** Unique opencode session ids in sessions.txt order (lines without a ses_ token are kept verbatim). */
export function parseSessionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const found = line.match(SESSION_ID);
    if (found === null) ids.add(line);
    else for (const id of found) ids.add(id);
  }
  return [...ids];
}

async function readSessionIds(): Promise<string[]> {
  try {
    return parseSessionIds(await readFile(artifactPath("sessions.txt"), "utf8"));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}

async function main(): Promise<void> {
  const plan = await planCleanup(cleanupTargets());
  const preserved = preservedPaths();
  const keptBefore: string[] = [];
  for (const p of preserved) if (await exists(p)) keptBefore.push(p);

  for (const target of plan) {
    const checked = await validateTarget(target); // re-check right before the destructive op
    if (!(await existsAndNotLink(checked))) {
      console.log(`absent:  ${checked}`);
      continue;
    }
    await removeWithRetry(checked);
    console.log(`removed: ${checked}`);
  }

  for (const p of keptBefore) {
    if (!(await exists(p))) throw new Error(`preserved path disappeared: ${p}`);
    console.log(`kept:    ${p}`);
  }

  const ids = await readSessionIds();
  console.log(`\nopencode sessions to delete manually (no bulk delete) — ${ids.length}:`);
  for (const id of ids) console.log(`  ${id}`);
  console.log("COMPLETE");
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exit(1);
  });
}
