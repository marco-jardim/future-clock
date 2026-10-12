/**
 * "Last word" final pass at the HTTP boundary (plan D9/D11, decisions D-PF2/D-PF3).
 *
 * Runs on every outgoing provider request. Rewrites the Anthropic Messages body
 * (system, tool descriptions, "Today's date" lines, shell clock outputs) and only
 * replaces `event.request` when at least one string actually changed, so an
 * already-shifted body stays byte-identical (prompt cache preserved, idempotent).
 * Never throws: any failure is logged and the request is left untouched.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyCommand } from "../core/classify";
import { shiftYears } from "../core/years";
import type { HostPorts, HttpRequestEvent } from "./ports";
import { rewriteAnthropicBody, type RewriteFns } from "./wire";

export interface BoundaryHookDeps {
  years: number;
  realYear: () => number;
  log: HostPorts["log"];
  dumpDir?: string;
  enabled: boolean;
}

/** A line that opens with "Today's date:" / "Today's date is now:" (aligned with years.ts pattern 1). */
const ROLLOVER_LINE = /^[ \t]*Today['\u2019]s date(?: is now)?:/i;

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

  const rolloverOnly = (text: string): string => {
    const lines = text.split("\n");
    let changed = false;
    const out = lines.map((line): string => {
      if (!ROLLOVER_LINE.test(line)) return line;
      const result = shiftYears({ text: line, realYear, years, mode: "context" });
      if (result.count > 0) changed = true;
      return result.text;
    });
    return changed ? out.join("\n") : text;
  };

  const clock = (command: string, text: string): string =>
    classifyCommand(command).isClockRead
      ? shiftYears({ text, realYear, years, mode: "clock" }).text
      : text;

  return { context, rolloverOnly, clock };
}

/** Strings the model reads as "current" context: system prompt and tool descriptions. */
function detectorTargets(body: unknown): Array<{ where: string; text: string }> {
  const targets: Array<{ where: string; text: string }> = [];
  if (!isObject(body)) return targets;

  const system = body.system;
  if (typeof system === "string") {
    targets.push({ where: "system", text: system });
  } else if (Array.isArray(system)) {
    for (const part of system) {
      if (isObject(part) && typeof part.text === "string") {
        targets.push({ where: "system", text: part.text });
      }
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isObject(tool) && typeof tool.description === "string") {
        const name = typeof tool.name === "string" ? tool.name : "?";
        targets.push({ where: `tool:${name}`, text: tool.description });
      }
    }
  }
  return targets;
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

  /** D11 detector: a real (unshifted) year still inside date-shaped context text. */
  const detect = (body: unknown, realYear: number): void => {
    for (const target of detectorTargets(body)) {
      const probe = shiftYears({ text: target.text, realYear, years: 1, mode: "context" });
      if (probe.count > 0) {
        warnOnce(
          `detector:${target.where}`,
          `future-clock: real year ${realYear} still present in date-shaped text of ${target.where} (enabled=${deps.enabled})`,
        );
      }
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

    const text = await request.clone().text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      warnOnce(
        `shape:${origin}`,
        `future-clock: request body to ${origin} is not JSON (${describeError(error)}); left untouched`,
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
      headers.delete("content-length");
      event.request = new Request(request.url, {
        method: request.method,
        headers,
        body: finalText,
        signal: request.signal,
      });
    }

    try {
      detect(finalBody, realYear);
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
