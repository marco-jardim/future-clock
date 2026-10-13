/**
 * "Last word" final pass at the HTTP boundary (plan D9/D11, decisions D-PF2/D-PF3).
 *
 * Runs on every outgoing provider request. Rewrites the Anthropic Messages body
 * (system, tool descriptions, "Today's date is now:" rollover lines of
 * non-assistant messages, classified shell clock outputs) and only replaces
 * `event.request` when at least one string actually changed, so an
 * already-shifted body stays byte-identical (prompt cache preserved, idempotent).
 * Never throws: any failure is logged and the request is left untouched.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyCommand } from "../core/classify";
import type { ShiftInput } from "../core/types";
import { shiftRolloverLines, shiftYears } from "../core/years";
import type { HostPorts, HttpRequestEvent } from "./ports";
import { rewriteAnthropicBody, shellToolResults, type RewriteFns } from "./wire";

export interface BoundaryHookDeps {
  years: number;
  realYear: () => number;
  log: HostPorts["log"];
  dumpDir?: string;
  enabled: boolean;
}

/** Per-process dump sequence (shared by every hook instance so file names never collide). */
let dumpSeq = 0;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Origin only (scheme://host:port) — never path or query, which may carry identifiers. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch (error) {
    return `invalid-url(${describeError(error)})`;
  }
}

/** File-name-safe token (no separators, no traversal). */
function safeToken(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned : "_";
}

function makeFns(years: number, realYear: number): RewriteFns {
  const context = (text: string): string =>
    shiftYears({ text, realYear, years, mode: "context" }).text;

  // D10/D-PF9: only "Today's date is now:" lines; plain "Today's date:" in a message stays.
  const rolloverOnly = (text: string): string => shiftRolloverLines(text, realYear, years).text;

  const clock = (command: string, text: string): string =>
    classifyCommand(command).isClockRead
      ? shiftYears({ text, realYear, years, mode: "clock" }).text
      : text;

  return { context, rolloverOnly, clock };
}

interface DetectorTarget {
  where: string;
  text: string;
  mode: ShiftInput["mode"];
}

/**
 * Strings the model reads as "current": system prompt and tool descriptions
 * (date-shaped spans), plus outputs of shell commands classified as clock reads
 * (every real year, as the clock rewrite does).
 */
function detectorTargets(body: unknown): DetectorTarget[] {
  const targets: DetectorTarget[] = [];
  if (!isObject(body)) return targets;

  const system = body.system;
  if (typeof system === "string") {
    targets.push({ where: "system", text: system, mode: "context" });
  } else if (Array.isArray(system)) {
    for (const part of system) {
      if (isObject(part) && typeof part.text === "string") {
        targets.push({ where: "system", text: part.text, mode: "context" });
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isObject(tool) && typeof tool.description === "string") {
        const name = typeof tool.name === "string" ? tool.name : "?";
        targets.push({ where: `tool:${name}`, text: tool.description, mode: "context" });
      }
    }
  }

  for (const result of shellToolResults(body)) {
    if (classifyCommand(result.command).isClockRead) {
      targets.push({ where: "tool_result", text: result.text, mode: "clock" });
    }
  }
  return targets;
}

/** Real-year occurrences per detector location (insertion order = body order). */
function countRealYears(body: unknown, realYear: number, years: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of detectorTargets(body)) {
    const probe = shiftYears({ text: target.text, realYear, years, mode: target.mode });
    counts.set(target.where, (counts.get(target.where) ?? 0) + probe.count);
  }
  return counts;
}

export function createBoundaryHook(
  deps: BoundaryHookDeps,
): (event: HttpRequestEvent) => Promise<void> {
  const warned = new Set<string>();

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    deps.log("warn", message);
  };

  /**
   * D11 detector: measures real-year date shapes in the body as received
   * (before the final pass) and in the body actually sent; warns once per
   * location when any survive in what is sent.
   */
  const detect = (before: unknown, after: unknown, realYear: number): void => {
    const found = countRealYears(before, realYear, deps.years);
    const remaining = after === before ? found : countRealYears(after, realYear, deps.years);
    for (const [where, count] of remaining) {
      if (count === 0) continue;
      warnOnce(
        `detector:${where}`,
        `future-clock: real year ${realYear} still present in date-shaped text of ${where} ` +
          `after the final pass (${count} left, ${found.get(where) ?? 0} before; enabled=${deps.enabled})`,
      );
    }
  };

  /** D11 dump: final body text (exactly what is sent) + L3 summary. Never headers. */
  const dump = async (
    event: HttpRequestEvent,
    finalText: string,
    summary: { changed: number; applied: boolean; origin: string },
  ): Promise<void> => {
    const dir = deps.dumpDir;
    if (dir === undefined || dir.length === 0) return;
    try {
      dumpSeq += 1;
      const base = `${safeToken(event.sessionID)}-${safeToken(event.kind)}-${dumpSeq}`;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${base}.json`), finalText, "utf8");
      const l3 = {
        changed: summary.changed,
        applied: summary.applied,
        origin: summary.origin,
        kind: event.kind,
      };
      await writeFile(join(dir, `${base}.l3.json`), JSON.stringify(l3), "utf8");
    } catch (error) {
      deps.log("error", `future-clock: dump write failed in ${dir}: ${describeError(error)}`);
    }
  };

  const handle = async (event: HttpRequestEvent): Promise<void> => {
    const request = event.request;
    if (request.method.toUpperCase() !== "POST") return;
    const origin = originOf(request.url);

    if (request.headers.has("content-encoding")) {
      warnOnce(
        `encoding:${origin}`,
        `future-clock: request to ${origin} has content-encoding; body left untouched`,
      );
      return;
    }

    const raw = await request.clone().arrayBuffer();
    const text = new TextDecoder().decode(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // N7: the parse error message can quote body tokens; log a fixed text + size only.
      warnOnce(
        `not-json:${origin}`,
        `future-clock: request body to ${origin} is not JSON (${raw.byteLength} bytes); left untouched`,
      );
      return;
    }

    const realYear = deps.realYear();
    const result = rewriteAnthropicBody(parsed, makeFns(deps.years, realYear));
    if (result === undefined) {
      warnOnce(
        `shape:${origin}`,
        `future-clock: request body to ${origin} has an unknown shape; left untouched`,
      );
      return;
    }

    const apply = deps.enabled && result.changed > 0;
    const finalText = apply ? JSON.stringify(result.body) : text;
    const finalBody = apply ? result.body : parsed;

    if (apply) {
      const headers = new Headers(request.headers);
      // The new body has its own length and is not chunked by us; content-type is
      // copied as-is (a binary body never adds an implicit text/plain).
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      event.request = new Request(request.url, {
        method: request.method,
        headers,
        body: new TextEncoder().encode(finalText),
        signal: request.signal,
      });
    }

    try {
      detect(parsed, finalBody, realYear);
    } catch (error) {
      deps.log("error", `future-clock: detector failed: ${describeError(error)}`);
    }
    await dump(event, finalText, { changed: result.changed, applied: apply, origin });
  };

  return async (event: HttpRequestEvent): Promise<void> => {
    const original = event.request;
    try {
      await handle(event);
    } catch (error) {
      event.request = original;
      deps.log(
        "error",
        `future-clock: boundary hook failed, request left untouched: ${describeError(error)}`,
      );
    }
  };
}
