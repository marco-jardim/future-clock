/**
 * Builds the plugin as a directory package (decision D-PF5):
 *   dist/future-clock/server.js     bundle of src/plugin/index.ts (target bun)
 *   dist/future-clock/package.json  minimal manifest pointing at server.js
 * Host packages (@opencode/plugin, effect) stay external; the build fails if
 * a copy of @opencode or effect code ended up embedded in the bundle.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "plugin", "index.ts");
const OUT_DIR = join(ROOT, "dist", "future-clock");
const BUNDLE = join(OUT_DIR, "server.js");
const MANIFEST = join(OUT_DIR, "package.json");
const EMBEDDED_HOST_MARKERS: readonly string[] = [
  "node_modules/@opencode",
  "node_modules\\@opencode",
  "node_modules/effect",
  "node_modules\\effect",
];

const manifest = {
  name: "future-clock",
  version: "0.1.0",
  type: "module",
  main: "./server.js",
  exports: { ".": "./server.js", "./server": "./server.js" },
};

function fail(message: string): never {
  console.error(`[build] ${message}`);
  process.exit(1);
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((inner: unknown) => describeError(inner)).join("\n");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [ENTRY],
      outdir: OUT_DIR,
      target: "bun",
      format: "esm",
      external: ["@opencode/plugin", "effect"],
      naming: { entry: "server.js" },
    });
  } catch (error) {
    fail(`bundle failed:\n${describeError(error)}`);
  }

  if (!result.success) {
    const details = result.logs.map((log) => String(log)).join("\n");
    fail(`bundle failed:\n${details}`);
  }

  const bundleFile = Bun.file(BUNDLE);
  if (!(await bundleFile.exists())) fail(`expected bundle not found: ${BUNDLE}`);

  const code = await bundleFile.text();
  for (const marker of EMBEDDED_HOST_MARKERS) {
    if (code.includes(marker)) {
      fail(`bundle embeds host code (found "${marker}"); @opencode packages and effect must stay external`);
    }
  }

  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[build] wrote ${BUNDLE} (${code.length} bytes)`);
  console.log(`[build] wrote ${MANIFEST}`);
}

main().catch((error: unknown) => {
  fail(describeError(error));
});
