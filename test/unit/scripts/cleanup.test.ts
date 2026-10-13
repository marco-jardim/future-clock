// Pure validation tests: planCleanup only reads (realpath/lstat); nothing is ever deleted here.
import { describe, expect, test } from "bun:test";
import { cleanupTargets, parseSessionIds, planCleanup, preservedPaths } from "../../../scripts/cleanup";
import { ARTIFACTS, PROBE_ROOT, SANDBOX, artifactPath } from "../../../scripts/lib/artifacts";

describe("cleanup", () => {
  test("cleanupTargets is exactly sandbox, probe root, iso and probe\\dist (never preserved data)", () => {
    const targets = cleanupTargets();
    expect(targets).toEqual([SANDBOX, PROBE_ROOT, artifactPath("iso"), artifactPath("probe", "dist")]);
    expect(PROBE_ROOT).toBe("D:\\future-probe");
    for (const keep of [artifactPath("runs"), artifactPath("dumps"), artifactPath("probe"), ARTIFACTS]) {
      expect(targets.map((t) => t.toLowerCase())).not.toContain(keep.toLowerCase());
    }
    expect(preservedPaths()).toContain(artifactPath("runs"));
    expect(preservedPaths()).toContain(artifactPath("dumps"));
  });

  test("planCleanup rejects a tampered list (all-or-nothing)", async () => {
    const tampered = [
      "D:\\",
      "C:\\Users\\Marquinho",
      artifactPath("runs"),
      "D:\\future-probe\\..\\x",
      artifactPath("dumps"),
      artifactPath("probe"),
      ARTIFACTS,
      "D:\\future-probe\\sub",
      "D:\\future-sandbox\\..\\x",
      "\\\\?\\D:\\future-sandbox",
      "future-sandbox",
    ];
    for (const bad of tampered) {
      await expect(planCleanup([...cleanupTargets(), bad])).rejects.toThrow();
      await expect(planCleanup([bad])).rejects.toThrow();
    }
  });

  test("planCleanup accepts the default list; parseSessionIds dedupes", async () => {
    expect(await planCleanup(cleanupTargets())).toEqual(cleanupTargets());
    expect(await planCleanup(["d:\\FUTURE-SANDBOX", "D:\\Future-Probe"])).toEqual([SANDBOX, PROBE_ROOT]);
    expect(parseSessionIds("ses_a\r\nses_b\n\nses_a\n")).toEqual(["ses_a", "ses_b"]);
  });
});
