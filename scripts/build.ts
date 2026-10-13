/**
 * Builds the plugin as a publishable npm directory package (decision D-PF5):
 *   dist/future-clock/server.js     bundle of src/plugin/index.ts (target bun)
 *   dist/future-clock/package.json  publishable manifest (opencode-future-clock)
 *   dist/future-clock/README.md     copied from the repository root
 *   dist/future-clock/LICENSE       copied from the repository root
 * Host packages (@opencode/plugin, effect) stay external; the build fails if
 * a copy of @opencode or effect code ended up embedded in the bundle, or if
 * the bundle imports @opencode/plugin at runtime (it is type-only).
 */

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "plugin", "index.ts");
const ROOT_PACKAGE = join(ROOT, "package.json");
const OUT_DIR = join(ROOT, "dist", "future-clock");
const BUNDLE = join(OUT_DIR, "server.js");
const MANIFEST = join(OUT_DIR, "package.json");
const COPIED_FILES: readonly string[] = ["README.md", "LICENSE"];
const EMBEDDED_HOST_MARKERS: readonly string[] = [
  "node_modules/@opencode",
  "node_modules\\@opencode",
  "node_modules/effect",
  "node_modules\\effect",
];

/**
 * Runtime references to @opencode/plugin (or a subpath): static `import ... from`,
 * side-effect `import "..."`, `export ... from`, dynamic `import(...)` and `require(...)`.
 */
const RUNTIME_HOST_IMPORT =
  /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']@opencode\/plugin(?:\/[^"']*)?["']/;

/** Pure: the publishable manifest for dist/future-clock, versioned from the root package.json. */
export function buildManifest(rootPkg: { version: string }): Record<string, unknown> {
  return {
    name: "opencode-future-clock",
    version: rootPkg.version,
    description:
      "opencode v2 plugin that makes the model perceive the current year as real year + N (only the year changes).",
    type: "module",
    main: "./server.js",
    exports: { ".": "./server.js", "./server": "./server.js" },
    files: ["server.js", "README.md", "LICENSE"],
    keywords: ["opencode", "opencode-plugin", "plugin", "time", "date", "llm", "agents"],
    license: "MIT",
    author: "Marco Jardim",
    repository: { type: "git", url: "git+https://github.com/marco-jardim/future-clock.git" },
    homepage: "https://github.com/marco-jardim/future-clock#readme",
    bugs: { url: "https://github.com/marco-jardim/future-clock/issues" },
    engines: { opencode: ">=2.0.0" },
  };
}

/** Pure: true when the bundle code references @opencode/plugin at runtime. */
export function hasRuntimeHostImport(code: string): boolean {
  return RUNTIME_HOST_IMPORT.test(code);
}

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

async function readRootVersion(): Promise<string> {
  const parsed: unknown = await Bun.file(ROOT_PACKAGE).json();
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    fail(`root package.json has no "version": ${ROOT_PACKAGE}`);
  }
  const version: unknown = parsed.version;
  if (typeof version !== "string" || version.length === 0) {
    fail(`root package.json "version" must be a non-empty string: ${ROOT_PACKAGE}`);
  }
  return version;
}

async function main(): Promise<void> {
  const version = await readRootVersion();

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
  if (hasRuntimeHostImport(code)) {
    fail(`bundle imports "@opencode/plugin" at runtime; it must be a type-only import`);
  }

  for (const name of COPIED_FILES) {
    const source = join(ROOT, name);
    if (!(await Bun.file(source).exists())) fail(`required file not found: ${source}`);
    await copyFile(source, join(OUT_DIR, name));
    console.log(`[build] copied ${name}`);
  }

  await writeFile(MANIFEST, `${JSON.stringify(buildManifest({ version }), null, 2)}\n`, "utf8");
  console.log(`[build] wrote ${BUNDLE} (${code.length} bytes)`);
  console.log(`[build] wrote ${MANIFEST}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    fail(describeError(error));
  });
}
