import { describe, expect, test } from "bun:test";
import { buildManifest, hasRuntimeHostImport } from "../../../scripts/build";

describe("buildManifest", () => {
  const manifest = buildManifest({ version: "0.1.0" });

  test("publishes as opencode-future-clock with the root version", () => {
    expect(manifest.name).toBe("opencode-future-clock");
    expect(manifest.version).toBe("0.1.0");
    expect(buildManifest({ version: "9.8.7" }).version).toBe("9.8.7");
  });

  test("is an ESM package whose entry points are the bundle", () => {
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./server.js");
    expect(manifest.exports).toEqual({ ".": "./server.js", "./server": "./server.js" });
  });

  test("ships only the bundle, README and LICENSE", () => {
    expect(manifest.files).toEqual(["server.js", "README.md", "LICENSE"]);
  });

  test("carries license, repository and links metadata", () => {
    expect(manifest.license).toBe("MIT");
    expect(manifest.author).toBe("Marco Jardim");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/marco-jardim/future-clock.git",
    });
    expect(manifest.homepage).toBe("https://github.com/marco-jardim/future-clock#readme");
    expect(manifest.bugs).toEqual({ url: "https://github.com/marco-jardim/future-clock/issues" });
    expect(manifest.engines).toEqual({ opencode: ">=2.0.0" });
    expect(manifest.keywords).toContain("opencode-plugin");
  });

  test("declares no dependencies (the bundle is self-contained)", () => {
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("peerDependencies");
    expect(manifest).not.toHaveProperty("optionalDependencies");
    expect(manifest).not.toHaveProperty("devDependencies");
    expect(manifest).not.toHaveProperty("private");
  });
});

describe("hasRuntimeHostImport", () => {
  test("detects runtime references to @opencode/plugin", () => {
    expect(hasRuntimeHostImport('import { x } from "@opencode/plugin";')).toBe(true);
    expect(hasRuntimeHostImport("import*as p from'@opencode/plugin/sub';")).toBe(true);
    expect(hasRuntimeHostImport('import "@opencode/plugin";')).toBe(true);
    expect(hasRuntimeHostImport('await import("@opencode/plugin")')).toBe(true);
    expect(hasRuntimeHostImport('require("@opencode/plugin")')).toBe(true);
    expect(hasRuntimeHostImport('export { y } from "@opencode/plugin";')).toBe(true);
  });

  test("accepts bundles without such references", () => {
    expect(hasRuntimeHostImport('import { join } from "node:path";')).toBe(false);
    expect(hasRuntimeHostImport('const id = "future-clock";')).toBe(false);
    expect(hasRuntimeHostImport('import x from "@opencode/plugin-other";')).toBe(false);
  });
});
