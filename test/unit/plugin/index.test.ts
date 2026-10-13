import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findRepoRoot, resolveDumpDir, setupWith } from "../../../src/plugin/index";
import type { ContextEvent } from "../../../src/plugin/ports";
import { createFakeHost } from "./fake-ctx";

const fixedNow = (): Date => new Date(2026, 9, 12);

describe("setupWith", () => {
  test("registers exactly 3 callbacks (context, execute.after, http.request)", async () => {
    const host = createFakeHost();
    const cleanup = await setupWith(host.ports, undefined, {}, fixedNow);
    expect(host.registrations).toBe(3);
    await cleanup();
  });

  test("cleanup disposes every registration", async () => {
    const host = createFakeHost();
    const cleanup = await setupWith(host.ports, { years: 120 }, {}, fixedNow);
    expect(host.registrations).toBe(3);
    await cleanup();
    expect(host.registrations).toBe(0);
    expect(host.logs).toEqual([]);
  });

  test("invalid years throws and registers nothing", async () => {
    const host = createFakeHost();
    await expect(setupWith(host.ports, { years: Number.NaN }, {}, fixedNow)).rejects.toThrow();
    expect(host.registrations).toBe(0);
  });

  test("unknown option throws a clear error", async () => {
    const host = createFakeHost();
    await expect(setupWith(host.ports, { years: 120, foo: 1 }, {}, fixedNow)).rejects.toThrow(
      /unknown option foo/,
    );
    expect(host.registrations).toBe(0);
  });

  test("relative FUTURE_CLOCK_DUMP_DIR throws", async () => {
    const host = createFakeHost();
    await expect(
      setupWith(host.ports, undefined, { FUTURE_CLOCK_DUMP_DIR: "relative/dumps" }, fixedNow),
    ).rejects.toThrow(/FUTURE_CLOCK_DUMP_DIR/);
    expect(host.registrations).toBe(0);
  });

  test("FUTURE_CLOCK_DUMP_DIR inside the repository throws and registers nothing", async () => {
    const host = createFakeHost();
    const insideRepo = resolve(import.meta.dir, "..", "..", "..", ".tmp", "dumps");
    await expect(
      setupWith(host.ports, undefined, { FUTURE_CLOCK_DUMP_DIR: insideRepo }, fixedNow),
    ).rejects.toThrow(/inside the repository/);
    expect(host.registrations).toBe(0);
  });

  test("absolute FUTURE_CLOCK_DUMP_DIR outside the repository is accepted", async () => {
    const host = createFakeHost();
    const outside = join(tmpdir(), "future-clock-index-test-dumps");
    const cleanup = await setupWith(host.ports, undefined, { FUTURE_CLOCK_DUMP_DIR: outside }, fixedNow);
    expect(host.registrations).toBe(3);
    await cleanup();
  });

  test("end-to-end: context date line is shifted to 2146", async () => {
    const host = createFakeHost();
    const cleanup = await setupWith(host.ports, undefined, {}, fixedNow);
    const event: ContextEvent = {
      sessionID: "ses_test",
      system: [{ type: "text", text: "Today's date: Mon Oct 12 2026" }],
      messages: [],
      tools: {},
    };
    const out = await host.fire.context(event);
    const text = out.system.map((part) => part.text).join("\n");
    expect(text).toContain("2146");
    expect(text).not.toContain("2026");
    await cleanup();
  });
});

describe("resolveDumpDir (N6)", () => {
  const winRepo = "D:\\git\\future-agents";
  const win = (dir: string | undefined): string | undefined =>
    resolveDumpDir({ FUTURE_CLOCK_DUMP_DIR: dir }, winRepo, "win32");

  test("unset or empty means no dumps", () => {
    expect(win(undefined)).toBeUndefined();
    expect(win("")).toBeUndefined();
  });

  test("absolute drive path outside the repository is returned as is", () => {
    expect(win("C:\\dumps\\future-clock")).toBe("C:\\dumps\\future-clock");
    expect(win("D:/other/dumps")).toBe("D:/other/dumps");
  });

  test("sibling directory sharing the repository name prefix is allowed", () => {
    expect(win("D:\\git\\future-agents-dumps")).toBe("D:\\git\\future-agents-dumps");
  });

  test("relative paths are rejected", () => {
    expect(() => win("relative\\dumps")).toThrow(/must be an absolute path/);
    expect(() => win("C:dumps")).toThrow(/must be an absolute path/);
  });

  test("UNC paths are rejected (backslash and slash forms)", () => {
    expect(() => win("\\\\server\\share\\dumps")).toThrow(/UNC/);
    expect(() => win("//server/share/dumps")).toThrow(/UNC/);
    expect(() => win("\\\\?\\C:\\dumps")).toThrow(/UNC/);
  });

  test("root-relative paths are rejected", () => {
    expect(() => win("\\dumps")).toThrow(/root-relative/);
    expect(() => win("/dumps")).toThrow(/root-relative/);
  });

  test("'..' segments are rejected, including Win32 spellings", () => {
    expect(() => win("C:\\dumps\\..\\x")).toThrow(/'\.\.' segments/);
    expect(() => win("C:/dumps/../x")).toThrow(/'\.\.' segments/);
    expect(() => win("C:\\dumps\\...\\x")).toThrow(/'\.\.' segments/);
    expect(() => win("C:\\dumps\\.. \\x")).toThrow(/'\.\.' segments/);
    expect(() => win("C:\\dumps\\..")).toThrow(/'\.\.' segments/);
  });

  test("the repository itself and anything inside it are rejected", () => {
    expect(() => win("D:\\git\\future-agents")).toThrow(/inside the repository/);
    expect(() => win("D:\\git\\future-agents\\")).toThrow(/inside the repository/);
    expect(() => win("D:\\git\\future-agents\\.tmp\\dumps")).toThrow(/inside the repository/);
    expect(() => win("D:/git/future-agents/.tmp/dumps")).toThrow(/inside the repository/);
  });

  test("repository containment is case-insensitive and ignores Win32 trailing dots/spaces", () => {
    expect(() => win("d:\\GIT\\Future-Agents\\.tmp\\dumps")).toThrow(/inside the repository/);
    expect(() => win("D:\\git\\future-agents.\\dumps")).toThrow(/inside the repository/);
    expect(() => win("D:\\git\\future-agents \\dumps")).toThrow(/inside the repository/);
  });

  test("posix: absolute path accepted, repository and UNC-like '//' rejected", () => {
    const repo = "/home/u/future-agents";
    const posixDir = (dir: string): string | undefined =>
      resolveDumpDir({ FUTURE_CLOCK_DUMP_DIR: dir }, repo, "linux");
    expect(posixDir("/tmp/dumps")).toBe("/tmp/dumps");
    expect(() => posixDir("/home/u/future-agents/dumps")).toThrow(/inside the repository/);
    expect(() => posixDir("/HOME/U/Future-Agents/dumps")).toThrow(/inside the repository/);
    expect(() => posixDir("//host/dumps")).toThrow(/UNC/);
    expect(() => posixDir("\\dumps")).toThrow(/root-relative/);
    expect(() => posixDir("/tmp/../home/u/future-agents")).toThrow(/'\.\.' segments/);
    expect(() => posixDir("tmp/dumps")).toThrow(/must be an absolute path/);
  });

  test("default protected root is this repository", () => {
    const insideRepo = resolve(import.meta.dir, "..", "..", "..", "dist", "dumps");
    expect(() => resolveDumpDir({ FUTURE_CLOCK_DUMP_DIR: insideRepo })).toThrow(/inside the repository/);
  });

  test("no repository found: only the containment check is skipped", () => {
    const noRepo = (dir: string): string | undefined =>
      resolveDumpDir({ FUTURE_CLOCK_DUMP_DIR: dir }, () => undefined, "win32");
    expect(noRepo("D:\\git\\future-agents\\.tmp\\dumps")).toBe("D:\\git\\future-agents\\.tmp\\dumps");
    expect(() => noRepo("relative\\dumps")).toThrow(/must be an absolute path/);
    expect(() => noRepo("\\\\server\\share\\dumps")).toThrow(/UNC/);
    expect(() => noRepo("\\dumps")).toThrow(/root-relative/);
    expect(() => noRepo("C:\\dumps\\..\\x")).toThrow(/'\.\.' segments/);
  });

  test("protected root is looked up lazily, only when FUTURE_CLOCK_DUMP_DIR is set", () => {
    let lookups = 0;
    const lookup = (): string => {
      lookups += 1;
      return winRepo;
    };
    expect(resolveDumpDir({}, lookup, "win32")).toBeUndefined();
    expect(resolveDumpDir({ FUTURE_CLOCK_DUMP_DIR: "" }, lookup, "win32")).toBeUndefined();
    expect(lookups).toBe(0);
    expect(() => resolveDumpDir({ FUTURE_CLOCK_DUMP_DIR: "D:\\git\\future-agents\\x" }, lookup, "win32")).toThrow(
      /inside the repository/,
    );
    expect(lookups).toBe(1);
  });
});

describe("findRepoRoot", () => {
  test("default (source location) resolves to this repository", () => {
    expect(findRepoRoot()).toBe(resolve(import.meta.dir, "..", "..", ".."));
  });

  test("candidate two levels up counts only when it holds .git", () => {
    const moduleDir = resolve("cache", "node_modules", "opencode-future-clock");
    const candidate = resolve(moduleDir, "..", "..");
    expect(findRepoRoot(moduleDir, () => false)).toBeUndefined();
    const probed: string[] = [];
    const exists = (path: string): boolean => {
      probed.push(path);
      return path === join(candidate, ".git");
    };
    expect(findRepoRoot(moduleDir, exists)).toBe(candidate);
    expect(probed).toEqual([join(candidate, ".git")]);
  });

  test("real filesystem: no .git means no protected root, a .git directory means protected", async () => {
    const base = await mkdtemp(join(tmpdir(), "future-clock-repo-root-"));
    try {
      const moduleDir = join(base, "dist", "future-clock");
      await mkdir(moduleDir, { recursive: true });
      expect(findRepoRoot(moduleDir)).toBeUndefined();
      await mkdir(join(base, ".git"));
      expect(findRepoRoot(moduleDir)).toBe(resolve(base));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
