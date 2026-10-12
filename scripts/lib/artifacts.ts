// Artifact locations (outside the repo) and the path-containment guard used before any destructive op.
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TEMP_ROOT = "C:\\Users\\Marquinho\\AppData\\Local\\Temp\\Claude";
export const SANDBOX = "D:\\future-sandbox";
export const PROBE_ROOT = "D:\\future-probe";
export const ARTIFACTS = join(TEMP_ROOT, "future-artifacts");

export const ARTIFACT_DIRS = {
  config: join(ARTIFACTS, "config"),
  xdgConfig: join(ARTIFACTS, "xdg-config"),
  dumps: join(ARTIFACTS, "dumps"),
  runs: join(ARTIFACTS, "runs"),
  state: join(ARTIFACTS, "state"),
} as const;

/** Path inside the artifacts directory, e.g. artifactPath("state", "probe.json"). */
export function artifactPath(...parts: string[]): string {
  return join(ARTIFACTS, ...parts);
}

/** Isolated XDG config root; its opencode\opencode.json replaces the user's global config. */
export const ISOLATION_XDG_CONFIG = artifactPath("iso", "xdg-config");

/** Env overrides that hide the user's global opencode config (use together with --standalone). */
export function isolationEnv(): Record<string, string> {
  return { XDG_CONFIG_HOME: ISOLATION_XDG_CONFIG };
}

/** Creates <xdg-config>\opencode\opencode.json = "{}" if missing. */
export async function ensureIsolationDirs(): Promise<void> {
  const dir = join(ISOLATION_XDG_CONFIG, "opencode");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "opencode.json"), "{}", { flag: "wx" });
  } catch (e) {
    if (errorCode(e) !== "EEXIST") throw e;
  }
}

function errorCode(e: unknown): unknown {
  return e instanceof Error ? Reflect.get(e, "code") : undefined;
}

/**
 * Real path of `p`: realpath of the deepest existing ancestor (following links/junctions)
 * plus the not-yet-existing remainder. A dangling link is refused (its target is unknowable).
 */
async function resolveReal(p: string): Promise<string> {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (e) {
      const code = errorCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
    try {
      await lstat(current);
      throw new Error(`refusing dangling link or unreadable entry: ${current}`);
    } catch (e) {
      if (errorCode(e) !== "ENOENT" && errorCode(e) !== "ENOTDIR") throw e;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`no existing ancestor for: ${p}`);
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target); // case-insensitive on win32
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Throws unless `target` is an absolute, `..`-free, non-UNC path whose real location is inside `root`. */
export async function assertUnder(root: string, target: string): Promise<string> {
  if (/^[\\/]{2}/.test(target)) throw new Error(`UNC/device path not allowed: ${target}`);
  const absolute = process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(target) : isAbsolute(target);
  if (!absolute) throw new Error(`path must be absolute: ${target}`);
  if (target.split(/[\\/]/).includes("..")) throw new Error(`".." segment not allowed: ${target}`);

  const normalized = resolve(target);
  const [realRoot, realTarget] = await Promise.all([resolveReal(resolve(root)), resolveReal(normalized)]);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`path escapes root (${realRoot}): ${target} -> ${realTarget}`);
  }
  return normalized;
}
