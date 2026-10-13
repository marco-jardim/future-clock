/**
 * future-clock plugin entrypoint (plan task 1.7, decision D-PF5).
 *
 * `setupWith` wires the three hooks against abstract host ports so it can be
 * exercised with a fake host; the default export adapts the real opencode
 * plugin context. This is the only place in src/ that reads the wall clock.
 */

import { existsSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { createBoundaryHook } from "./boundary-hook";
import { createContextHook } from "./context-hook";
import { hostPortsFromContext } from "./host-adapter";
import { parseOptions } from "./options";
import type { HostPorts, Registration } from "./ports";
import { createToolHook } from "./tool-hook";

export interface FutureClockEnv {
  FUTURE_CLOCK_DUMP_DIR?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Repository root to protect from dumps, or undefined when there is none.
 * In a checkout this module sits two directories below the root both as source
 * (`src/plugin/index.ts`) and as the bundle (`dist/future-clock/server.js`).
 * When installed from npm the module lives in some cache's node_modules, where
 * "two levels up" is meaningless; so the candidate only counts when it holds a
 * `.git` entry (a directory, or the `.git` file of a worktree/submodule).
 */
export function findRepoRoot(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidate = resolve(moduleDir, "..", "..");
  return exists(join(candidate, ".git")) ? candidate : undefined;
}

/** A fixed root, or a lazy lookup (called only when FUTURE_CLOCK_DUMP_DIR is set); undefined skips the check. */
export type ProtectedRoot = string | (() => string | undefined);

/** `..` plus the Win32 spellings that normalize to it (`...`, `.. `). */
const PARENT_SEGMENT = /^\.\.[. ]*$/;

type PathApi = typeof win32;

/** Comparable form: separators unified, trailing dots/spaces per segment dropped (Win32 does), lower-cased. */
function comparable(path: string, api: PathApi): string {
  return api
    .resolve(path)
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[. ]+$/, ""))
    .filter((segment) => segment.length > 0)
    .join("/")
    .toLowerCase();
}

function isInside(child: string, root: string, api: PathApi): boolean {
  const c = comparable(child, api);
  const r = comparable(root, api);
  return c === r || c.startsWith(`${r}/`);
}

/**
 * Validates `FUTURE_CLOCK_DUMP_DIR`: absolute, not UNC (`\\x`, `//x`), not
 * root-relative (`\x`; also `/x` on win32), no `..` segments, and not inside
 * `protectedRoot` (the repository, compared case-insensitively). The default
 * root is looked up lazily via `findRepoRoot`; when no repository is found
 * (npm install) only the containment check is skipped.
 * Returns undefined when unset/empty; throws a clear error otherwise.
 */
export function resolveDumpDir(
  env: FutureClockEnv,
  protectedRoot: ProtectedRoot = findRepoRoot,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const raw = env.FUTURE_CLOCK_DUMP_DIR;
  if (raw === undefined || raw.length === 0) return undefined;
  const api: PathApi = platform === "win32" ? win32 : posix;
  const reject = (reason: string): Error =>
    new Error(`future-clock: FUTURE_CLOCK_DUMP_DIR ${reason}, got "${raw}"`);
  if (raw.startsWith("\\\\") || raw.startsWith("//")) throw reject("must not be a UNC path");
  if (raw.startsWith("\\") || (platform === "win32" && raw.startsWith("/"))) {
    throw reject("must not be root-relative");
  }
  if (!api.isAbsolute(raw)) throw reject("must be an absolute path");
  if (raw.split(/[\\/]+/).some((segment) => PARENT_SEGMENT.test(segment))) {
    throw reject("must not contain '..' segments");
  }
  const root = typeof protectedRoot === "string" ? protectedRoot : protectedRoot();
  if (root !== undefined && isInside(raw, root, api)) {
    throw reject(`must not be inside the repository (${root})`);
  }
  return raw;
}

async function disposeAll(ports: HostPorts, registrations: readonly Registration[]): Promise<void> {
  const results = await Promise.allSettled(registrations.map((registration) => registration.dispose()));
  for (const result of results) {
    if (result.status === "rejected") {
      ports.log("error", `future-clock: failed to dispose a hook registration: ${describeError(result.reason)}`);
    }
  }
}

/**
 * Validates options/env, registers the context, execute.after and http.request
 * hooks, and returns a cleanup that disposes every registration.
 * Throws (rejects) with a clear message on invalid options or env; in that case
 * nothing stays registered.
 */
export async function setupWith(
  ports: HostPorts,
  rawOptions: unknown,
  env: FutureClockEnv,
  now: () => Date = () => new Date(),
): Promise<() => Promise<void>> {
  const realYear = (): number => now().getFullYear();
  const options = parseOptions(rawOptions, realYear());
  const dumpDir = resolveDumpDir(env);
  const log: HostPorts["log"] = (level, message) => ports.log(level, message);

  const registrations: Registration[] = [];
  try {
    registrations.push(
      await ports.onContext(createContextHook({ years: options.years, realYear, log })),
    );
    registrations.push(
      await ports.onExecuteAfter(createToolHook({ years: options.years, realYear, log })),
    );
    registrations.push(
      await ports.onHttpRequest(
        createBoundaryHook({ years: options.years, realYear, log, dumpDir, enabled: true }),
      ),
    );
  } catch (error) {
    await disposeAll(ports, registrations);
    throw error;
  }

  return async (): Promise<void> => {
    const current = registrations.splice(0, registrations.length);
    await disposeAll(ports, current);
  };
}

/** Plain object typed against the host (D2: type-only import, no runtime dependency on @opencode/plugin). */
const plugin: Plugin.Plugin = {
  id: "future-clock",
  setup: (ctx) =>
    setupWith(hostPortsFromContext(ctx), ctx.options, {
      FUTURE_CLOCK_DUMP_DIR: process.env.FUTURE_CLOCK_DUMP_DIR,
    }),
};

export default plugin;
