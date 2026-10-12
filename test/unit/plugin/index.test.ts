import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDumpDir, setupWith } from "../../../src/plugin/index";
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
});
