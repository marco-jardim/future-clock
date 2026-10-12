import { classifyCommand } from "../core/classify";
import { shiftYears } from "../core/years";
import type { ExecuteAfterEvent, HostPorts, ToolContentItem, ToolResultLike } from "./ports";

/** Dependencies of the `tool.execute.after` hook (U3). */
export interface ToolHookDeps {
  readonly years: number;
  readonly realYear: () => number;
  readonly log: HostPorts["log"];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type CompletedEvent = Extract<ExecuteAfterEvent, { status: "completed" }>;
type ErrorEvent = Extract<ExecuteAfterEvent, { status: "error" }>;

/** Shifts one string; returns the (possibly unchanged) text and the number of replacements. */
type Shift = (text: string) => { text: string; count: number };

interface Rewritten<T> {
  readonly value: T;
  readonly count: number;
}

const SHELL_TOOL = "shell";

/**
 * Typed narrowing of a tool input to its shell command: an object carrying a
 * string `command` property. Anything else yields `undefined`.
 */
export function extractCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if (!("command" in input)) return undefined;
  const command: unknown = input.command;
  return typeof command === "string" ? command : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function rewriteContent(
  content: string | ReadonlyArray<ToolContentItem>,
  shift: Shift,
): Rewritten<string | ReadonlyArray<ToolContentItem>> {
  if (typeof content === "string") {
    const shifted = shift(content);
    return { value: shifted.text, count: shifted.count };
  }
  if (!Array.isArray(content)) return { value: content, count: 0 };
  let count = 0;
  const value = content.map((item: ToolContentItem): ToolContentItem => {
    if (item.type !== "text" || typeof item.text !== "string") return item;
    const shifted = shift(item.text);
    if (shifted.count === 0) return item;
    count += shifted.count;
    return { ...item, text: shifted.text };
  });
  return { value, count };
}

/**
 * Builds a new result (fields are readonly) with shifted `content`/`output`.
 * Keys absent from the original stay absent; `metadata` keeps its reference.
 * Returns `undefined` when nothing was replaced.
 */
function rewriteResult(result: ToolResultLike, shift: Shift): ToolResultLike | undefined {
  const next: Mutable<ToolResultLike> = { ...result };
  let count = 0;

  if (result.content !== undefined) {
    const content = rewriteContent(result.content, shift);
    if (content.count > 0) {
      next.content = content.value;
      count += content.count;
    }
  }

  if (typeof result.output === "string") {
    const output = shift(result.output);
    if (output.count > 0) {
      next.output = output.text;
      count += output.count;
    }
  }

  return count > 0 ? next : undefined;
}

function rewriteCompleted(event: CompletedEvent, shift: Shift): void {
  const next = rewriteResult(event.result, shift);
  if (next !== undefined) event.result = next;
}

const READONLY_ERROR_WARNING = "[future-clock] tool hook: error message is read-only; clock rewrite skipped";

/**
 * Shifts the error message in place. A frozen/readonly error is left intact
 * (replacing it with a plain-object copy would drop its prototype, e.g.
 * `Tool.Error`), and the skipped rewrite is logged as a warning.
 */
function rewriteError(event: ErrorEvent, shift: Shift, log: HostPorts["log"]): void {
  const shifted = shift(event.error.message);
  if (shifted.count === 0) return;
  const message = shifted.text;
  try {
    event.error.message = message;
  } catch (error: unknown) {
    // Strict mode: assigning to a frozen/readonly property throws a TypeError.
    log("warn", `${READONLY_ERROR_WARNING} (${describeError(error)})`);
    return;
  }
  // Non-strict hosts fail silently on frozen objects: verify instead of assuming success.
  if (event.error.message !== message) log("warn", READONLY_ERROR_WARNING);
}

/**
 * Creates the `tool.execute.after` hook (U3): when the shell tool ran a
 * clock-reading command, shifts target years in its result (mode "clock").
 * Never touches `event.input`; never throws (failures are logged and the event
 * is left unchanged). Sub-agent sessions are handled identically.
 */
export function createToolHook(deps: ToolHookDeps): (event: ExecuteAfterEvent) => void {
  // The plugin builds a single hook per process, so this flag warns once per process.
  let warnedMissingCommand = false;

  return (event: ExecuteAfterEvent): void => {
    try {
      if (event.tool !== SHELL_TOOL) return;

      const command = extractCommand(event.input);
      if (command === undefined) {
        if (!warnedMissingCommand) {
          warnedMissingCommand = true;
          deps.log(
            "warn",
            "[future-clock] tool hook: shell input has no string `command`; clock rewrite skipped (logged once)",
          );
        }
        return;
      }

      if (!classifyCommand(command).isClockRead) return;

      const realYear = deps.realYear();
      const shift: Shift = (text) => shiftYears({ text, realYear, years: deps.years, mode: "clock" });

      if (event.status === "completed") {
        rewriteCompleted(event, shift);
      } else {
        rewriteError(event, shift, deps.log);
      }
    } catch (error: unknown) {
      deps.log("error", `[future-clock] tool hook failed: ${describeError(error)}`);
    }
  };
}
