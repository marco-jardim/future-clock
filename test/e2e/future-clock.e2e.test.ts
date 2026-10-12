// End-to-end suite (plan §7.2, E0–E6). Opt in with FUTURE_E2E=1: it needs real opencode + credentials
// and shares D:\future-sandbox, so tests must run sequentially (bun runs one file's tests in order).
import { describe, expect, test } from "bun:test";
import {
  ROUTER_SENTINEL,
  TEST_TIMEOUT_MS,
  hasDateShapedYear,
  hasYearToken,
  isShellTool,
  loadL3,
  loadSentinels,
  readAllDumpText,
  readToolResults,
  realYear,
  runScenario,
  runWithRetry,
  secretHits,
  shellToolResults,
  shiftedYear,
  systemText,
  toolDescriptions,
} from "./helpers";
import type { Dump, Scenario } from "./helpers";

const DATE_PROMPT = "Que dia é hoje? Responda só a data em ISO.";
const TODAY_LINE = /^[ \t]*Today['\u2019]s date:.*$/m;
const CLOCK_COMMAND = /Get-Date/i;

/** E1 bodies, reused by E3. */
let e1: Scenario | undefined;

function responseText(s: Scenario): string {
  return s.run.texts.join("\n");
}

function calledTool(s: Scenario, predicate: (tool: string) => boolean): boolean {
  return s.run.toolCalls.some((c) => predicate(c.tool));
}

function expectProduced(s: Scenario): void {
  expect(s.run.timedOut).toBe(false);
  expect(s.run.dumps.length).toBeGreaterThan(0);
  expect(s.bodies.length).toBeGreaterThan(0);
}

/** E7: no date-shaped real year in the system prompt or tool descriptions of any primary body. */
function expectNoRealYearInPrompts(bodies: Dump[]): void {
  const real = realYear();
  for (const body of bodies) {
    expect(hasDateShapedYear(systemText(body), real)).toBe(false);
    for (const tool of toolDescriptions(body)) {
      expect(hasDateShapedYear(tool.description, real)).toBe(false);
    }
  }
}

/** E8: no credential-looking text in any dump file (title and side files included). */
async function expectNoSecrets(s: Scenario): Promise<void> {
  expect(secretHits(await readAllDumpText(s.run.dumps))).toEqual([]);
}

function expectShiftedTodayLine(body: Dump): void {
  const line = TODAY_LINE.exec(systemText(body))?.[0];
  expect(line).toBeDefined();
  expect(hasYearToken(line ?? "", shiftedYear())).toBe(true);
  expect(hasYearToken(line ?? "", realYear())).toBe(false);
}

/** Oracle: the context/tool hooks shifted everything before the wire boundary (L3 changed nothing). */
async function expectL3Untouched(bodies: Dump[]): Promise<void> {
  for (const body of bodies) {
    const l3 = await loadL3(body);
    expect(l3.changed).toBe(0);
  }
}

function expectShiftedAnswer(s: Scenario): void {
  expect(hasYearToken(responseText(s), shiftedYear())).toBe(true);
  expect(hasYearToken(responseText(s), realYear())).toBe(false);
}

const ROUTER_ROLE_NAMES: readonly string[] = ["explorer", "implementer", "reviewer", "researcher", "architect", "runner"];

function lastBody(bodies: Dump[]): Dump {
  const last = bodies[bodies.length - 1];
  if (last === undefined) throw new Error("no primary dump");
  return last;
}

describe.skipIf(process.env["FUTURE_E2E"] !== "1")("future-clock e2e", () => {
  test(
    "E0 isolation: no sentinel from the global config reaches the wire",
    async () => {
      const s = await runScenario({
        name: "e0",
        arm: "treatment",
        prompt: "Responda apenas: ok.",
        isolated: true,
      });
      expectProduced(s);
      const { sentinels } = await loadSentinels();
      expect(sentinels.length).toBeGreaterThan(0);
      const raw = await readAllDumpText(s.run.dumps);
      for (const sentinel of sentinels) expect(raw.includes(sentinel)).toBe(false);
      for (const body of s.bodies) expect(systemText(body).includes("Sisyphus")).toBe(false);
      expect(raw.includes(ROUTER_SENTINEL)).toBe(false);
      for (const body of s.bodies) {
        for (const tool of toolDescriptions(body)) {
          if (tool.name !== "subagent") continue;
          for (const role of ROUTER_ROLE_NAMES) {
            expect(new RegExp(`\\b${role}\\b`, "i").test(tool.description)).toBe(false);
          }
        }
      }
      expectNoRealYearInPrompts(s.bodies);
      await expectNoSecrets(s);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E1 system prompt carries the shifted date and the answer uses it",
    async () => {
      const s = await runScenario({
        name: "e1",
        arm: "treatment",
        prompt: "Que dia é hoje? Responda só a data em ISO (AAAA-MM-DD).",
        isolated: true,
      });
      e1 = s;
      expectProduced(s);
      for (const body of s.bodies) expectShiftedTodayLine(body);
      expect(responseText(s).includes(String(shiftedYear()))).toBe(true);
      await expectL3Untouched(s.bodies);
      expectNoRealYearInPrompts(s.bodies);
      await expectNoSecrets(s);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E2 shell clock output is shifted, read output is untouched",
    async () => {
      const s = await runWithRetry(
        () =>
          runScenario({
            name: "e2",
            arm: "treatment",
            prompt:
              "Rode Get-Date e depois (Get-Date).Year no shell, em chamadas separadas, cole as saídas, e depois leia o arquivo notes.txt.",
            isolated: true,
          }),
        (r) => calledTool(r, isShellTool) && calledTool(r, (t) => t.toLowerCase() === "read") && r.bodies.length > 0,
      );
      expectProduced(s);
      const last = lastBody(s.bodies);
      const clock = shellToolResults(last).filter((r) => CLOCK_COMMAND.test(r.command));
      expect(clock.length).toBeGreaterThan(0);
      for (const result of clock) {
        expect(hasYearToken(result.text, shiftedYear())).toBe(true);
        expect(hasYearToken(result.text, realYear())).toBe(false);
      }
      const reads = readToolResults(last);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.some((text) => text.includes("2026-10-12"))).toBe(true);
      // notes.txt legitimately holds the real year (out of scope by design), so the answer may quote it.
      expect(hasYearToken(responseText(s), shiftedYear())).toBe(true);
      await expectL3Untouched(s.bodies);
      expectNoRealYearInPrompts(s.bodies);
      await expectNoSecrets(s);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E3 websearch description announces the shifted year",
    async () => {
      if (e1 === undefined) throw new Error("E1 did not produce a scenario (E3 depends on it)");
      const expected = `The current year is ${shiftedYear()}`;
      const found = e1.bodies.some((body) =>
        toolDescriptions(body).some((t) => t.name === "websearch" && t.description.includes(expected)),
      );
      expect(found).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E4 subagent sessions are shifted too",
    async () => {
      const s = await runWithRetry(
        () =>
          runScenario({
            name: "e4",
            arm: "treatment",
            prompt:
              "Use a ferramenta subagent para que um subagente rode Get-Date no shell e me devolva a saída exata.",
            isolated: true,
          }),
        (r) => calledTool(r, (t) => t.toLowerCase() === "subagent") && r.bodies.length > 0,
      );
      expectProduced(s);
      const sessions = new Set(s.bodies.map((b) => b.sessionID));
      expect(sessions.size).toBeGreaterThanOrEqual(2);
      const parent = s.run.parentSessionID;
      expect(parent).toBeDefined();
      const children = s.bodies.filter((b) => b.sessionID !== parent);
      expect(children.length).toBeGreaterThan(0);
      for (const body of children) expectShiftedTodayLine(body);
      const childClock = children
        .flatMap((b) => shellToolResults(b))
        .filter((r) => CLOCK_COMMAND.test(r.command));
      expect(childClock.length).toBeGreaterThan(0);
      for (const result of childClock) {
        expect(hasYearToken(result.text, shiftedYear())).toBe(true);
        expect(hasYearToken(result.text, realYear())).toBe(false);
      }
      expectShiftedAnswer(s);
      await expectL3Untouched(s.bodies);
      expectNoRealYearInPrompts(s.bodies);
      await expectNoSecrets(s);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E5 control arm (no plugin) answers with the real year",
    async () => {
      const s = await runScenario({ name: "e5", arm: "control", prompt: DATE_PROMPT, isolated: true });
      expect(s.run.timedOut).toBe(false);
      const text = responseText(s);
      expect(hasYearToken(text, realYear())).toBe(true);
      expect(hasYearToken(text, shiftedYear())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "E6 coexists with the real global config and the model router",
    async () => {
      const s = await runWithRetry(
        () =>
          runScenario({
            name: "e6",
            arm: "treatment",
            prompt:
              "Use a ferramenta subagent para que um subagente rode Get-Date no shell e me devolva a saída exata; depois diga que dia é hoje.",
            isolated: false,
            printLogs: true,
          }),
        (r) => calledTool(r, (t) => t.toLowerCase() === "subagent") && r.bodies.length > 0,
      );
      expectProduced(s);
      const { sentinels } = await loadSentinels();
      expect(sentinels.length).toBeGreaterThan(0);
      const system = s.bodies.map(systemText).join("\n");
      expect(sentinels.some((sentinel) => system.includes(sentinel))).toBe(true);
      const parent = s.run.parentSessionID;
      expect(parent).toBeDefined();
      // The router injects its protocol only into the parent session; child bodies do not carry it.
      const parentBodies = s.bodies.filter((b) => b.sessionID === parent);
      expect(parentBodies.length).toBeGreaterThan(0);
      for (const body of parentBodies) expect(systemText(body).includes(ROUTER_SENTINEL)).toBe(true);
      expect(new Set(s.bodies.map((b) => b.sessionID)).size).toBeGreaterThanOrEqual(2);
      const children = s.bodies.filter((b) => b.sessionID !== parent);
      expect(children.length).toBeGreaterThan(0);
      for (const body of children) expectShiftedTodayLine(body);
      expectNoRealYearInPrompts(s.bodies);
      for (const body of s.bodies) {
        for (const result of shellToolResults(body).filter((r) => CLOCK_COMMAND.test(r.command))) {
          expect(hasYearToken(result.text, realYear())).toBe(false);
        }
      }
      const failed = s.run.stderr.split(/\r?\n/).filter((line) => line.includes("[future-clock]") && /failed/i.test(line));
      expect(failed).toEqual([]);
      expect(s.run.stderr.includes("loading plugin")).toBe(true);
      await expectNoSecrets(s);
    },
    TEST_TIMEOUT_MS,
  );
});
