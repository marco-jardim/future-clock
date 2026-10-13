// Recreates the isolated sandbox D:\future-sandbox (treatment = plugin enabled, control = no plugins).
// Usage: bun scripts/sandbox.ts [treatment|control]
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { SANDBOX, ensureIsolationDirs } from "./lib/artifacts";
import { DEFAULT_MODEL } from "./lib/opencode-run";

export type Arm = "treatment" | "control";

export interface SandboxOptions {
  arm: Arm;
  years?: number;
  model?: string;
}

const REPO_ROOT = join(import.meta.dir, "..");
export const PLUGIN_DIR = join(REPO_ROOT, "dist", "future-clock");
export const NOTES_TEXT = "Nota criada em 2026-10-12.\n";
const EXPECTED_ENTRIES = [".git", "notes.txt", "opencode.json"];
const RM_TRIES = 5;
const RM_BACKOFF_MS = 500;
/** Transient Windows lock errors while a previous opencode/git process releases the directory. */
const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/** Throws unless `p` is exactly SANDBOX (case-insensitive, after normalization); returns SANDBOX. */
export function assertIsSandbox(p: string): string {
  if (/^[\\/]{2}/.test(p)) throw new Error(`UNC/device path not allowed: ${p}`);
  if (!/^[A-Za-z]:[\\/]/.test(p)) throw new Error(`path must be absolute: ${p}`);
  if (win32.resolve(p).toLowerCase() !== win32.resolve(SANDBOX).toLowerCase()) {
    throw new Error(`refusing to touch anything but ${SANDBOX}: ${p}`);
  }
  return SANDBOX;
}

/** Project opencode.json for an arm. */
export function sandboxConfig(opts: SandboxOptions): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: opts.model ?? DEFAULT_MODEL,
    plugins: opts.arm === "treatment" ? [{ package: PLUGIN_DIR, options: { years: opts.years ?? 120 } }] : [],
  };
}

function errorCode(e: unknown): unknown {
  return e instanceof Error ? Reflect.get(e, "code") : undefined;
}

async function removeWithRetry(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = errorCode(e);
      if (attempt >= RM_TRIES || typeof code !== "string" || !RETRYABLE.has(code)) throw e;
      await Bun.sleep(RM_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Throws if `dir` is a link/junction, or if its real path differs from `dir` (case-insensitive) —
 * i.e. a reparse point/junction anywhere in the chain. A missing `dir` is fine (nothing to delete).
 */
export async function refuseLink(dir: string): Promise<void> {
  let isLink: boolean;
  try {
    isLink = (await lstat(dir)).isSymbolicLink();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return;
    throw e;
  }
  if (isLink) throw new Error(`refusing: ${dir} is a link/junction`);
  const real = await realpath(dir);
  if (win32.resolve(real).toLowerCase() !== win32.resolve(dir).toLowerCase()) {
    throw new Error(`refusing: ${dir} resolves elsewhere (${real})`);
  }
}

async function gitInit(dir: string): Promise<void> {
  const git = Bun.which("git") ?? "git";
  const proc = Bun.spawn([git, "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git init failed in ${dir} (${code}): ${stderr.slice(0, 300)}`);
}

/** Recreates SANDBOX with only .git, opencode.json and notes.txt; returns its path. */
export async function createSandbox(opts: SandboxOptions): Promise<string> {
  const dir = assertIsSandbox(SANDBOX);
  await refuseLink(dir);
  await removeWithRetry(dir);
  await mkdir(dir, { recursive: true });
  await gitInit(dir);
  await writeFile(join(dir, "notes.txt"), NOTES_TEXT);
  await writeFile(join(dir, "opencode.json"), `${JSON.stringify(sandboxConfig(opts), null, 2)}\n`);
  const entries = (await readdir(dir)).sort();
  if (entries.join("|") !== EXPECTED_ENTRIES.join("|")) {
    throw new Error(`unexpected sandbox contents: ${entries.join(", ")}`);
  }
  await ensureIsolationDirs();
  return dir;
}

function parseArm(arg: string | undefined): Arm {
  if (arg === undefined || arg === "treatment") return "treatment";
  if (arg === "control") return "control";
  throw new Error(`unknown arm: ${arg} (expected treatment|control)`);
}

if (import.meta.main) {
  const arm = parseArm(process.argv[2]);
  createSandbox({ arm }).then(
    (dir) => console.log(`sandbox ready (${arm}): ${dir}`),
    (e: unknown) => {
      console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      process.exit(1);
    },
  );
}
