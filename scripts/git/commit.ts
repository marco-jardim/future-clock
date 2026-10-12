// Commit queue (plan §0.4): processes .tmp/commits/*.json in filename order.
// Each item is { message, paths }. Stops at the first failure.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface QueueItem { message: string; paths: string[]; }

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const QUEUE_DIR = join(REPO_ROOT, ".tmp", "commits");
const MESSAGE_FILE = join(REPO_ROOT, ".tmp", "commit-message.txt");

const HEADER_RE = /^(feat|fix|test|docs|chore|refactor|perf|build|ci)(\([^()\s]+\))?!?: \S.*$/;
const FORBIDDEN: readonly RegExp[] = [
  /co-?\s?authored[- ]?by/i,
  /generated (with|by|using)/i,
  /noreply@anthropic\.com/i,
  /\bclaude\b.*<[^>]*@anthropic\.com>/i,
];

/**
 * Canonical form used by the forbidden-text checks, so look-alikes cannot bypass them:
 * NFKC, format chars (zero-width etc.) removed, every dash mapped to "-", any whitespace run
 * (NBSP and newlines included) collapsed to a single space.
 */
export function normalizeForCheck(msg: string): string {
  return msg
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Pd}/gu, "-")
    .replace(/\s+/gu, " ");
}

/** Returns an error description, or null when the message is acceptable. */
export function validateMessage(msg: string): string | null {
  if (msg.trim() === "") return "empty commit message";
  const header = msg.split(/\r?\n/, 1)[0] ?? "";
  if (!HEADER_RE.test(header)) {
    return `header does not match "type(scope)?: subject" with type in feat|fix|test|docs|chore|refactor|perf|build|ci: "${header}"`;
  }
  const canonical = normalizeForCheck(msg);
  for (const re of FORBIDDEN) {
    if (re.test(canonical)) return `message contains forbidden text (${re.source})`;
  }
  return null;
}

/** Arguments for `git add`, restricted to the listed paths taken literally (no pathspec magic). */
export function buildAddArgs(paths: readonly string[]): string[] {
  return ["--literal-pathspecs", "add", "--", ...paths];
}

/** Arguments for `git commit` that record only the listed paths, whatever else is staged. */
export function buildCommitArgs(msgFile: string, paths: readonly string[]): string[] {
  return ["--literal-pathspecs", "commit", "-F", msgFile, "--only", "--", ...paths];
}

function parseItem(raw: unknown): QueueItem | string {
  if (typeof raw !== "object" || raw === null) return "queue item is not an object";
  const message: unknown = Reflect.get(raw, "message");
  const paths: unknown = Reflect.get(raw, "paths");
  if (typeof message !== "string") return "`message` must be a string";
  if (!Array.isArray(paths) || paths.length === 0) return "`paths` must be a non-empty array";
  const list: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || p.trim() === "") return "`paths` must contain only non-empty strings";
    list.push(p);
  }
  return { message, paths: list };
}

async function git(args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: (out + err).trim() };
}

type Outcome = { ok: true } | { ok: false; error: string; committed: boolean };

function fail(error: string, committed = false): Outcome {
  return { ok: false, error, committed };
}

/** Re-reads the message actually recorded in HEAD (hooks may have altered it) and validates it. */
async function verifyRecordedMessage(): Promise<string | null> {
  const log = await git(["log", "-1", "--format=%B"]);
  if (log.code !== 0) return `could not read HEAD message (exit ${log.code}): ${log.output}`;
  const invalid = validateMessage(log.output);
  if (invalid === null) return null;
  const head = await git(["rev-parse", "--short", "HEAD"]);
  return `recorded message of HEAD ${head.code === 0 ? head.output : "?"} is invalid: ${invalid}`;
}

async function processFile(file: string): Promise<Outcome> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(join(QUEUE_DIR, file)).text());
  } catch (e) {
    return fail(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const item = parseItem(raw);
  if (typeof item === "string") return fail(item);
  const invalid = validateMessage(item.message);
  if (invalid !== null) return fail(invalid);

  const added = await git(buildAddArgs(item.paths));
  if (added.code !== 0) return fail(`git add failed (exit ${added.code}): ${added.output}`);

  await mkdir(join(REPO_ROOT, ".tmp"), { recursive: true });
  await writeFile(MESSAGE_FILE, item.message.endsWith("\n") ? item.message : `${item.message}\n`, "utf8");
  const committed = await git(buildCommitArgs(MESSAGE_FILE, item.paths));
  await rm(MESSAGE_FILE, { force: true });
  if (committed.code !== 0) return fail(`git commit failed (exit ${committed.code}): ${committed.output}`);

  // The commit exists from here on: drop the queue item so a rerun cannot duplicate it.
  await rm(join(QUEUE_DIR, file));
  const recorded = await verifyRecordedMessage();
  if (recorded !== null) return fail(recorded, true);
  return { ok: true };
}

async function main(): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(QUEUE_DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if (e instanceof Error && Reflect.get(e, "code") === "ENOENT") {
      console.log("commit queue empty (no .tmp/commits directory)");
      return 0;
    }
    throw e;
  }
  let done = 0;
  for (const file of files) {
    const outcome = await processFile(file);
    if (!outcome.ok) {
      if (outcome.committed) {
        console.error("[commit] ################################################################");
        console.error(`[commit] !!! POST-COMMIT CHECK FAILED on ${file}: ${outcome.error}`);
        console.error("[commit] !!! The commit WAS created (history not rewritten). Fix it manually");
        console.error("[commit] !!! (e.g. git commit --amend) and check git hooks/config for injected text.");
        console.error("[commit] ################################################################");
        console.error(`[commit] ${done + 1} committed, queue stopped (file removed)`);
      } else {
        console.error(`[commit] FAILED on ${file}: ${outcome.error}`);
        console.error(`[commit] ${done} committed, queue stopped (file kept)`);
      }
      return 1;
    }
    done += 1;
    console.log(`[commit] ok ${file}`);
  }
  console.log(`[commit] ${done} commit(s) created, ${files.length - done} remaining`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
