/**
 * Wire-level rewrite of an Anthropic Messages request body (plan D9).
 *
 * Pure: no I/O, no clock. The parsed body is deep-cloned with `structuredClone`
 * and the clone is mutated in place, so key order is preserved and the caller's
 * object is never touched. Which spans actually change is decided by `fns`.
 */

export interface RewriteFns {
  /** System prompt and tool descriptions (date-shaped spans). */
  context(text: string): string;
  /** Conversation text: only "Today's date" lines are affected (fns decides). */
  rolloverOnly(text: string): string;
  /** Output of a shell tool call; `command` is the command that produced it. */
  clock(command: string, text: string): string;
}

type JsonObject = Record<string, unknown>;

/** Tool names whose `tool_result` content is a shell output (runtime: opencode "shell"). */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["shell"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is JsonObject & { type: "text"; text: string } {
  return isObject(value) && value.type === "text" && typeof value.text === "string";
}

interface Counter {
  changed: number;
}

/** Rewrites `holder[key]` when it is a string; counts it only if it actually changed. */
function rewriteField(
  holder: JsonObject,
  key: string,
  fn: (text: string) => string,
  counter: Counter,
): void {
  const value = holder[key];
  if (typeof value !== "string") return;
  const next = fn(value);
  if (next === value) return;
  holder[key] = next;
  counter.changed += 1;
}

/** Rewrites `holder[key]` when it is a string or an array of `{type:"text", text}` blocks. */
function rewriteContent(
  holder: JsonObject,
  key: string,
  fn: (text: string) => string,
  counter: Counter,
): void {
  const value = holder[key];
  if (typeof value === "string") {
    rewriteField(holder, key, fn, counter);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const block of value) {
    if (isTextBlock(block)) rewriteField(block, "text", fn, counter);
  }
}

function rewriteTools(tools: unknown, fns: RewriteFns, counter: Counter): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (isObject(tool)) rewriteField(tool, "description", (text) => fns.context(text), counter);
  }
}

/** Records shell `tool_use` ids -> command, so later `tool_result`s can be matched. */
function recordToolUse(block: JsonObject, shellCommands: Map<string, string>): void {
  if (typeof block.id !== "string" || typeof block.name !== "string") return;
  if (!SHELL_TOOL_NAMES.has(block.name)) return;
  const input = block.input;
  const command = isObject(input) && typeof input.command === "string" ? input.command : "";
  shellCommands.set(block.id, command);
}

function rewriteMessages(messages: unknown[], fns: RewriteFns, counter: Counter): void {
  const shellCommands = new Map<string, string>();
  const rollover = (text: string): string => fns.rolloverOnly(text);

  for (const message of messages) {
    if (!isObject(message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      rewriteField(message, "content", rollover, counter);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (isTextBlock(block)) {
        rewriteField(block, "text", rollover, counter);
      } else if (block.type === "tool_use") {
        recordToolUse(block, shellCommands);
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const command = shellCommands.get(block.tool_use_id);
        if (command === undefined) continue;
        rewriteContent(block, "content", (text) => fns.clock(command, text), counter);
      }
    }
  }
}

/**
 * Rewrites an Anthropic Messages body. Returns `undefined` for an unknown shape
 * (not an object with a `messages` array); otherwise the rewritten deep clone and
 * the number of strings that actually changed.
 */
export function rewriteAnthropicBody(
  body: unknown,
  fns: RewriteFns,
): { body: unknown; changed: number } | undefined {
  if (!isObject(body) || !Array.isArray(body.messages)) return undefined;

  const clone: unknown = structuredClone(body);
  if (!isObject(clone) || !Array.isArray(clone.messages)) return undefined;

  const counter: Counter = { changed: 0 };
  rewriteContent(clone, "system", (text) => fns.context(text), counter);
  rewriteTools(clone.tools, fns, counter);
  rewriteMessages(clone.messages, fns, counter);

  return { body: clone, changed: counter.changed };
}
