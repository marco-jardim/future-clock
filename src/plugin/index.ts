/**
 * future-clock plugin entrypoint (plan task 1.7, decision D-PF5).
 *
 * `setupWith` wires the three hooks against abstract host ports so it can be
 * exercised with a fake host; the default export adapts the real opencode
 * plugin context. This is the only place in src/ that reads the wall clock.
 */

import { isAbsolute } from "node:path";
import { Plugin } from "@opencode/plugin";
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

function resolveDumpDir(env: FutureClockEnv): string | undefined {
  const raw = env.FUTURE_CLOCK_DUMP_DIR;
  if (raw === undefined || raw.length === 0) return undefined;
  if (!isAbsolute(raw)) {
    throw new Error(`future-clock: FUTURE_CLOCK_DUMP_DIR must be an absolute path, got "${raw}"`);
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

export default Plugin.define({
  id: "future-clock",
  setup: (ctx) =>
    setupWith(hostPortsFromContext(ctx), ctx.options, {
      FUTURE_CLOCK_DUMP_DIR: process.env.FUTURE_CLOCK_DUMP_DIR,
    }),
});
