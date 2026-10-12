import { describe, expect, test } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D13: no secret-looking literal may be versioned. Scans the tracked-content
 * roots and fails on any match, reporting only `file:line` and the pattern
 * name (never the matched text).
 *
 * The patterns are built from split strings so this file never matches itself.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Roots scanned: a file or a directory relative to the repo root. */
const SCAN_ROOTS: readonly string[] = ["README.md", "docs", "src", "scripts", "test"];

/** Directory names skipped anywhere under a scan root. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", ".tmp"]);

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { name: "api-key", regex: new RegExp("\\b" + "sk" + "-[A-Za-z0-9_-]{20,}") },
  {
    name: "auth-header-json",
    regex: new RegExp('"(author' + "ization|x-api" + '-key)"\\s*:\\s*"', "i"),
  },
  { name: "bearer-token", regex: new RegExp("Bea" + "rer" + "\\s+\\S{20,}") },
];

interface Finding {
  location: string;
  pattern: string;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** docs/plans/*.md (direct children only) hold quoted QA evidence and are excluded. */
function isExcludedFile(relPath: string): boolean {
  const parts = toPosix(relPath).split("/");
  return parts.length === 3 && parts[0] === "docs" && parts[1] === "plans" && parts[2]?.endsWith(".md") === true;
}

async function collectFiles(absPath: string, out: string[]): Promise<void> {
  const info = await stat(absPath);
  if (info.isFile()) {
    if (!isExcludedFile(relative(REPO_ROOT, absPath))) out.push(absPath);
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(absPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() || entry.isFile()) await collectFiles(join(absPath, entry.name), out);
  }
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function scannedFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = join(REPO_ROOT, root);
    if (await exists(absRoot)) await collectFiles(absRoot, files);
  }
  return files.sort();
}

function scanText(text: string, relPath: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) findings.push({ location: `${relPath}:${index + 1}`, pattern: pattern.name });
    }
  });
  return findings;
}

describe("D13 secret scan of versioned content", () => {
  test("the patterns catch runtime-built secret-looking samples (scan is not vacuous)", () => {
    const key = ["sk", "ant", "x".repeat(24)].join("-");
    const samples = [
      `const key = "${key}";`,
      `{ ${JSON.stringify(["author", "ization"].join(""))}: "x" }`,
      `{ ${JSON.stringify(["x", "api", "key"].join("-"))} : "x" }`,
      `${["Bea", "rer"].join("")} ${"t".repeat(24)}`,
    ];
    const hits = samples.flatMap((sample) => scanText(sample, "sample").map((finding) => finding.pattern));
    expect(hits).toEqual(["api-key", "auth-header-json", "auth-header-json", "bearer-token"]);
  });

  test("README.md, docs, src, scripts and test contain no secret-looking literal", async () => {
    const files = await scannedFiles();
    const relFiles = files.map((file) => toPosix(relative(REPO_ROOT, file)));
    expect(relFiles).toContain("test/unit/secrets.test.ts");
    expect(relFiles.some((file) => file.startsWith("src/"))).toBe(true);

    const findings: Finding[] = [];
    for (const file of files) {
      const bytes = await readFile(file);
      if (bytes.includes(0)) continue; // binary content: not text, nothing to scan
      findings.push(...scanText(bytes.toString("utf8"), toPosix(relative(REPO_ROOT, file))));
    }
    expect(findings.map((finding) => `${finding.location} [${finding.pattern}]`)).toEqual([]);
  });
});
