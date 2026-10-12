// Commit queue (plan §0.4): processes .tmp/commits/*.json in filename order.
// Each item is { message, paths }. Stops at the first failure.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface QueueItem { message: string; paths: string[]; }

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const QUEUE_DIR = join(REPO_ROOT, ".tmp", "commits");
const MESSAGE_FILE = join(REPO_ROOT, ".tmp", "commit-message.txt");

const HEADER_RE = /^(feat|fix|test|docs|chore|refactor|perf|build|ci)(\([^()\s]+\))?!?: \S.*$/;
const FORBIDDEN: readonly RegExp[] = [/co-authored-by/i, /generated with/i];

/** Returns an error description, or null when the message is acceptable. */
export function validateMessage(msg: string): string | null {
  if (msg.trim() === "") return "empty commit message";
  const header = msg.split(/\r?\n/, 1)[0] ?? "";
  if (!HEADER_RE.test(header)) {
    return `header does not match "type(scope)?: subject" with type in feat|fix|test|docs|chore|refactor|perf|build|ci: "${header}"`;
  }
  for (const re of FORBIDDEN) {
    if (re.test(msg)) return `message contains forbidden text (${re.source})`;
  }
  return null;
}

/** Arguments for `git add`, restricted to the listed paths. */
export function buildAddArgs(paths: readonly string[]): string[] {
  return ["add", "--", ...paths];
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

async function processFile(file: string): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.file(join(QUEUE_DIR, file)).text());
  } catch (e) {
    return `invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const item = parseItem(raw);
  if (typeof item === "string") return item;
  const invalid = validateMessage(item.message);
  if (invalid !== null) return invalid;

  const added = await git(buildAddArgs(item.paths));
  if (added.code !== 0) return `git add failed (exit ${added.code}): ${added.output}`;

  await mkdir(join(REPO_ROOT, ".tmp"), { recursive: true });
  await writeFile(MESSAGE_FILE, item.message.endsWith("\n") ? item.message : `${item.message}\n`, "utf8");
  const committed = await git(["commit", "-F", MESSAGE_FILE]);
  await rm(MESSAGE_FILE, { force: true });
  if (committed.code !== 0) return `git commit failed (exit ${committed.code}): ${committed.output}`;

  await rm(join(QUEUE_DIR, file));
  return null;
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
    const error = await processFile(file);
    if (error !== null) {
      console.error(`[commit] FAILED on ${file}: ${error}`);
      console.error(`[commit] ${done} committed, queue stopped (file kept)`);
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
