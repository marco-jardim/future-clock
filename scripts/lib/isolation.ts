// Environment for spawning opencode: isolated (hidden global config) or real (user's global config).
import { isolationEnv } from "./artifacts";

/** Env vars that redirect opencode's global config; stripped when the real global config must load. */
const ISOLATION_KEYS: readonly string[] = ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"];

/**
 * Exact keys (upper-case) describing the parent process, not the run: `bun run`/npm inject INIT_CWD and
 * NODE/NODE_ENV, and opencode v2 takes its project directory from INIT_CWD/PWD instead of the spawn cwd.
 */
const PARENT_KEYS: readonly string[] = ["INIT_CWD", "PWD", "OLDPWD", "NODE", "NODE_ENV"];

/** Key prefixes (upper-case) of the parent's script runner (npm_*) and opencode session (OPENCODE*). */
const PARENT_PREFIXES: readonly string[] = ["NPM_", "OPENCODE"];

/** True when `key` (any case: Windows env names are case-insensitive) must not be inherited by a run. */
function isDropped(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    ISOLATION_KEYS.includes(upper) ||
    PARENT_KEYS.includes(upper) ||
    PARENT_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/** Copy of `source` keeping only string values. */
function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Env for an opencode run in `opts.cwd`. Always sets FUTURE_CLOCK_DUMP_DIR and PWD (= cwd). Inherited
 * XDG_CONFIG_HOME/OPENCODE_CONFIG_DIR (any case: Windows env names are case-insensitive) are always dropped:
 * non-isolated runs then load the real global config, isolated runs get only isolationEnv()'s values.
 * Parent-describing vars (INIT_CWD, PWD, OLDPWD, NODE, NODE_ENV, npm_*, OPENCODE*) are dropped too, so
 * opencode boots in `cwd` instead of the directory the parent script runner/session was started from.
 */
export function runEnv(
  opts: { isolated: boolean; dumpDir: string; cwd: string },
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base = stringEnv(source);
  for (const key of Object.keys(base)) {
    if (isDropped(key)) delete base[key];
  }
  return {
    ...base,
    PWD: opts.cwd,
    FUTURE_CLOCK_DUMP_DIR: opts.dumpDir,
    ...(opts.isolated ? isolationEnv() : {}),
  };
}
