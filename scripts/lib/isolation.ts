// Environment for spawning opencode: isolated (hidden global config) or real (user's global config).
import { isolationEnv } from "./artifacts";

/** Env vars that redirect opencode's global config; stripped when the real global config must load. */
const ISOLATION_KEYS = ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"] as const;

/** Copy of `source` keeping only string values. */
function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Env for an opencode run. Always sets FUTURE_CLOCK_DUMP_DIR. Inherited XDG_CONFIG_HOME/OPENCODE_CONFIG_DIR
 * (any case: Windows env names are case-insensitive) are always dropped: non-isolated runs then load the real
 * global config, isolated runs get only isolationEnv()'s values.
 */
export function runEnv(
  opts: { isolated: boolean; dumpDir: string },
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base = stringEnv(source);
  for (const key of Object.keys(base)) {
    if (ISOLATION_KEYS.some((k) => k === key.toUpperCase())) delete base[key];
  }
  return { ...base, FUTURE_CLOCK_DUMP_DIR: opts.dumpDir, ...(opts.isolated ? isolationEnv() : {}) };
}
