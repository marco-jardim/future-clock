import type { ClockClassification } from "./types";

/**
 * Detects shell commands that read (or set) the system clock.
 *
 * All regexes are case-insensitive and linear: every quantifier is followed by
 * a literal/class disjoint from what it repeats, and there are no nested
 * quantifiers. The `date`-as-a-command check avoids regex scanning entirely by
 * splitting on command separators and testing an anchored pattern per segment.
 */

interface ClockPattern {
  readonly name: string;
  readonly matches: (command: string) => boolean;
}

/** `Get-Date` cmdlet, token-bounded (not part of `Get-DateX` / `Target-Date`). */
const GET_DATE = /(?:^|[^\w-])get-date(?![\w-])/i;

/** `Set-Date` cmdlet, token-bounded. */
const SET_DATE = /(?:^|[^\w-])set-date(?![\w-])/i;

/** Separators after which a new command may start: `;`, `|`, `&&`, `||`, `(`, newline. */
const COMMAND_SEPARATORS = /[;|&(\r\n]/;

/** `date` at the very start of a (trimmed) segment, followed by end/space/`+`/`/`/`)`. */
const DATE_AT_SEGMENT_START = /^date(?:$|[\s+/)])/i;

/** `[DateTime]::Now|UtcNow|Today`, `[System.DateTime]::...`, `[DateTimeOffset]::Now|UtcNow`. */
const DOTNET_DATETIME =
  /\[\s*(?:system\.)?datetime(?:\s*\]\s*::\s*(?:utcnow|now|today)|offset\s*\]\s*::\s*(?:utcnow|now))(?!\w)/i;

/** Inline JS evaluation: `node -e|--eval|-p|--print`, `bun -e|--eval|-p|--print`, `deno eval`. */
const JS_INLINE_RUNNER =
  /(?:^|[^\w-])(?:(?:node|bun)(?:\.exe)?\s+(?:--eval|--print|-e|-p)|deno(?:\.exe)?\s+eval)(?![\w-])/i;

/** `new Date(` or `Date.now(`, not inside another identifier. */
const JS_CLOCK_EXPR = /(?:^|[^\w$])(?:new\s+Date\s*\(|Date\.now\s*\()/i;

/** Inline Python evaluation: `python -c`, `python3 -c`, `python3.12 -c`, `py -c`. */
const PYTHON_INLINE_RUNNER = /(?:^|[^\w.-])(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?\s+-c(?![\w-])/i;

/** `datetime.now|today|utcnow`, `date.today`, `time.time(`, not inside another identifier. */
const PYTHON_CLOCK_EXPR = /(?:^|[^\w])(?:datetime\.(?:utcnow|now|today)(?!\w)|date\.today(?!\w)|time\.time\s*\()/i;

function hasDateCommand(command: string): boolean {
  return command
    .split(COMMAND_SEPARATORS)
    .some((segment) => DATE_AT_SEGMENT_START.test(segment.trimStart()));
}

const PATTERNS: readonly ClockPattern[] = [
  { name: "get-date", matches: (command) => GET_DATE.test(command) },
  { name: "date-command", matches: hasDateCommand },
  { name: "dotnet-datetime", matches: (command) => DOTNET_DATETIME.test(command) },
  { name: "set-date", matches: (command) => SET_DATE.test(command) },
  {
    name: "js-date",
    matches: (command) => JS_INLINE_RUNNER.test(command) && JS_CLOCK_EXPR.test(command),
  },
  {
    name: "python-datetime",
    matches: (command) => PYTHON_INLINE_RUNNER.test(command) && PYTHON_CLOCK_EXPR.test(command),
  },
];

export function classifyCommand(command: string): ClockClassification {
  const matched = PATTERNS.filter((pattern) => pattern.matches(command)).map((pattern) => pattern.name);
  return { isClockRead: matched.length > 0, matched };
}
