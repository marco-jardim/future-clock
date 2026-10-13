import type { ClockClassification } from "./types";

/**
 * Detects shell commands that read (or set) the system clock.
 *
 * The command is scanned into segments split on unquoted separators (`;`,
 * `|`, `&`, newlines, and `(` only when not preceded by a word character, so
 * `$(date)` and `(Get-Date)` split but `print(date)` does not; `$(` also splits
 * inside double quotes). Segments whose first command is a search tool (`rg`,
 * `grep`, `findstr`, `Select-String`, `sls`, `git grep`, `git log`) have their
 * quoted arguments blanked before any pattern runs, so searching for
 * `"Get-Date"` is not mistaken for running it. Shell wrappers (`cmd /c`,
 * `bash|sh -c`, `wsl`, `pwsh -Command`) are unwrapped when looking for a `date`
 * command, and Python runners are tokenised so interpreter flags (`py -3`,
 * `-X utf8`) may precede `-c`.
 *
 * Every regex is linear: anchored, or with each quantifier followed by a
 * literal/class disjoint from what it repeats, and no nested quantifiers.
 * Segmenting, tokenising and unwrapping are single-pass hand-written scans.
 */

interface ClockPattern {
  readonly name: string;
  readonly matches: (command: string) => boolean;
}

/** A command segment; `text` is `command.slice(start, end)`. */
interface Segment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A whitespace-delimited token; `text` is `segment.slice(start, end)`. */
interface Token {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** `Get-Date` cmdlet, token-bounded (not part of `Get-DateX` / `Target-Date`). */
const GET_DATE = /(?:^|[^\w-])get-date(?![\w-])/i;

/** `Set-Date` cmdlet, token-bounded. */
const SET_DATE = /(?:^|[^\w-])set-date(?![\w-])/i;

/** Characters that end a segment when outside quotes (`(` is handled separately). */
const SEGMENT_SEPARATORS = ";|&\r\n";

const WORD_CHAR = /\w/;
const WHITESPACE = /\s/;

/** `date` at the very start of a (trimmed) segment, followed by end/space/`+`/`/`/`)`. */
const DATE_AT_SEGMENT_START = /^date(?:$|[\s+/)])/i;

/** cmd.exe `%DATE%` expansion, including substring forms such as `%DATE:~-4%`. */
const CMD_DATE_VARIABLE = /%date(?::[^%\r\n]*)?%/i;

/** `[DateTime]::Now|UtcNow|Today`, `[System.DateTime]::...`, `[DateTimeOffset]::Now|UtcNow`. */
const DOTNET_DATETIME =
  /\[\s*(?:system\.)?datetime(?:\s*\]\s*::\s*(?:utcnow|now|today)|offset\s*\]\s*::\s*(?:utcnow|now))(?!\w)/i;

/** Inline JS evaluation: `node -e|--eval|-p|--print`, `bun -e|--eval|-p|--print`, `deno eval`. */
const JS_INLINE_RUNNER =
  /(?:^|[^\w-])(?:(?:node|bun)(?:\.exe)?\s+(?:--eval|--print|-e|-p)|deno(?:\.exe)?\s+eval)(?![\w-])/i;

/** `new Date(` or `Date.now(`, not inside another identifier. */
const JS_CLOCK_EXPR = /(?:^|[^\w$])(?:new\s+Date\s*\(|Date\.now\s*\()/i;

/** Python interpreter as returned by `programName`: `python`, `python3`, `python3.12`, `py`. */
const PYTHON_INTERPRETER = /^(?:python(?:\d[\d.]*)?|py)$/;

/** `-c`, alone or ending a short-flag cluster (`-Ic`), possibly with attached code; never `-X…`/`-W…`. */
const PYTHON_INLINE_FLAG = /^-(?![XW])[A-Za-z]*c(?![\w-])/;

/** Python flags whose value is the next token. */
const PYTHON_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-X", "-W"]);

/**
 * `datetime.now|today|utcnow`, `date.today`, and
 * `time.time|time_ns|strftime|localtime|gmtime|ctime|asctime(`, not inside another identifier.
 */
const PYTHON_CLOCK_EXPR =
  /(?:^|[^\w])(?:datetime\.(?:utcnow|now|today)(?!\w)|date\.today(?!\w)|time\.(?:time_ns|time|strftime|localtime|gmtime|ctime|asctime)\s*\()/i;

/** Programs whose quoted arguments are search patterns, not code. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["rg", "grep", "egrep", "fgrep", "findstr", "select-string", "sls"]);

/** `git` subcommands whose quoted arguments are search patterns. */
const GIT_SEARCH_SUBCOMMANDS: ReadonlySet<string> = new Set(["grep", "log"]);

/** `git` global options whose value is the next token. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);

const POSIX_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const POSIX_SHELL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-o", "+o", "-O", "+O"]);
const SHORT_FLAG_CLUSTER = /^-[A-Za-z]+$/;

const POWERSHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell"]);

const WSL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-d",
  "--distribution",
  "--distribution-id",
  "-u",
  "--user",
  "--cd",
  "--shell-type",
]);
const WSL_COMMAND_MARKERS: ReadonlySet<string> = new Set(["-e", "--exec", "--"]);

/** Bounds wrapper recursion (`wsl bash -c "cmd /c date"`). */
const MAX_WRAPPER_DEPTH = 4;

/**
 * Splits `command` on separators outside quotes, and on `(` when it is not
 * preceded by a word character. Inside double quotes `$(` starts a new
 * (unquoted) segment, mirroring command substitution.
 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let quote = "";
  const cut = (end: number): void => {
    segments.push({ start, end, text: command.slice(start, end) });
    start = end + 1;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote !== "") {
      if (ch === quote) {
        quote = "";
      } else if (quote === '"' && ch === "(" && command.charAt(i - 1) === "$") {
        quote = "";
        cut(i);
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (SEGMENT_SEPARATORS.includes(ch) || (ch === "(" && !WORD_CHAR.test(command.charAt(i - 1)))) {
      cut(i);
    }
  }
  segments.push({ start, end: command.length, text: command.slice(start) });
  return segments;
}

function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let start = -1;
  for (let i = 0; i <= segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (ch === "" || WHITESPACE.test(ch)) {
      if (start >= 0) {
        tokens.push({ start, end: i, text: segment.slice(start, i) });
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }
  return tokens;
}

/** Trims and removes one layer of surrounding quotes (the closing one only if present). */
function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.charAt(0);
  if (quote !== '"' && quote !== "'") return trimmed;
  const body = trimmed.slice(1);
  return body.endsWith(quote) ? body.slice(0, -1) : body;
}

/** Lower-case program name of a token: quotes, directories and `.exe` removed. */
function programName(token: string): string {
  const unquoted = stripOuterQuotes(token);
  const slash = Math.max(unquoted.lastIndexOf("/"), unquoted.lastIndexOf("\\"));
  const base = unquoted.slice(slash + 1).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/** First POSIX shell word of `rest` without its quotes (the `sh -c` command string). */
function firstShellWord(rest: string): string {
  const text = rest.trimStart();
  const quote = text.charAt(0);
  if (quote === "'") {
    const close = text.indexOf("'", 1);
    return close < 0 ? text.slice(1) : text.slice(1, close);
  }
  if (quote === '"') {
    for (let i = 1; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        return text.slice(1, i);
      }
    }
    return text.slice(1);
  }
  const space = text.search(WHITESPACE);
  return space < 0 ? text : text.slice(0, space);
}

/** True when the segment's first command is a search tool (`rg`, `grep`, `sls`, `git grep|log`, ...). */
function isSearchCommand(segment: string): boolean {
  const tokens = tokenize(segment);
  const first = tokens[0];
  if (first === undefined) return false;
  const program = programName(first.text);
  if (SEARCH_TOOLS.has(program)) return true;
  if (program !== "git") return false;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    if (GIT_OPTIONS_WITH_VALUE.has(token.text)) {
      i += 1;
    } else if (!token.text.startsWith("-")) {
      return GIT_SEARCH_SUBCOMMANDS.has(token.text);
    }
  }
  return false;
}

/** Replaces quoted spans (quotes included) with spaces, preserving length. */
function blankQuoted(text: string): string {
  const chars: string[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote === "" && ch !== '"' && ch !== "'") {
      chars.push(ch);
      continue;
    }
    if (quote === "") {
      quote = ch;
    } else if (ch === quote) {
      quote = "";
    }
    chars.push(" ");
  }
  return chars.join("");
}

/** Blanks quoted arguments of search-tool segments; other segments are returned untouched. */
function maskSearchPatterns(command: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const segment of splitSegments(command)) {
    if (!isSearchCommand(segment.text)) continue;
    parts.push(command.slice(cursor, segment.start), blankQuoted(segment.text));
    cursor = segment.end;
  }
  if (parts.length === 0) return command;
  parts.push(command.slice(cursor));
  return parts.join("");
}

function unwrapCmd(segment: string, tokens: readonly Token[]): string | undefined {
  for (const token of tokens.slice(1)) {
    const flag = token.text.toLowerCase();
    if (flag === "/c" || flag === "/k") return stripOuterQuotes(segment.slice(token.end));
    if (!flag.startsWith("/")) return undefined;
  }
  return undefined;
}

function unwrapPosixShell(segment: string, tokens: readonly Token[]): string | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    const flag = token.text;
    if (SHORT_FLAG_CLUSTER.test(flag) && flag.includes("c")) return firstShellWord(segment.slice(token.end));
    if (POSIX_SHELL_OPTIONS_WITH_VALUE.has(flag)) {
      i += 1;
    } else if (!flag.startsWith("-") && !flag.startsWith("+")) {
      return undefined;
    }
  }
  return undefined;
}

function unwrapWsl(segment: string, tokens: readonly Token[]): string | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    const flag = token.text.toLowerCase();
    if (WSL_COMMAND_MARKERS.has(flag)) return segment.slice(token.end);
    if (WSL_OPTIONS_WITH_VALUE.has(flag)) {
      i += 1;
    } else if (!flag.startsWith("-")) {
      return segment.slice(token.start);
    }
  }
  return undefined;
}

/** True when `flag` is an abbreviation (at least `-x`) of the PowerShell parameter `parameter`. */
function isParameterPrefix(flag: string, parameter: string): boolean {
  return flag.length >= 2 && parameter.startsWith(flag);
}

function unwrapPowerShell(segment: string, tokens: readonly Token[]): string | undefined {
  for (const token of tokens.slice(1)) {
    const flag = token.text.toLowerCase();
    if (isParameterPrefix(flag, "-command")) return stripOuterQuotes(segment.slice(token.end));
    if (isParameterPrefix(flag, "-file")) return undefined;
  }
  return undefined;
}

/** The command run by a shell wrapper segment (`cmd /c`, `bash -c`, `wsl`, `pwsh -c`), if any. */
function unwrapShell(segment: string): string | undefined {
  const tokens = tokenize(segment);
  const first = tokens[0];
  if (first === undefined) return undefined;
  const program = programName(first.text);
  if (program === "cmd") return unwrapCmd(segment, tokens);
  if (POSIX_SHELLS.has(program)) return unwrapPosixShell(segment, tokens);
  if (program === "wsl") return unwrapWsl(segment, tokens);
  if (POWERSHELLS.has(program)) return unwrapPowerShell(segment, tokens);
  return undefined;
}

function hasDateCommand(command: string, depth: number): boolean {
  return splitSegments(command).some((segment) => segmentRunsDate(segment.text, depth));
}

function segmentRunsDate(segment: string, depth: number): boolean {
  if (DATE_AT_SEGMENT_START.test(segment.trimStart())) return true;
  if (depth >= MAX_WRAPPER_DEPTH) return false;
  const inner = unwrapShell(segment);
  return inner !== undefined && inner.trim() !== "" && hasDateCommand(inner, depth + 1);
}

/** Single pass: an interpreter token, then flags (`-3`, `-I`, `-X utf8`), then `-c`. */
function segmentRunsInlinePython(segment: string): boolean {
  let readingFlags = false;
  let skipValue = false;
  for (const { text } of tokenize(segment)) {
    if (readingFlags) {
      if (skipValue) {
        skipValue = false;
        continue;
      }
      if (PYTHON_INLINE_FLAG.test(text)) return true;
      if (PYTHON_FLAGS_WITH_VALUE.has(text)) {
        skipValue = true;
        continue;
      }
      if (text.startsWith("-") && text !== "-m") continue;
    }
    readingFlags = PYTHON_INTERPRETER.test(programName(text));
  }
  return false;
}

function hasPythonInlineRunner(command: string): boolean {
  return splitSegments(command).some((segment) => segmentRunsInlinePython(segment.text));
}

const PATTERNS: readonly ClockPattern[] = [
  { name: "get-date", matches: (command) => GET_DATE.test(command) },
  { name: "date-command", matches: (command) => hasDateCommand(command, 0) },
  { name: "cmd-date-var", matches: (command) => CMD_DATE_VARIABLE.test(command) },
  { name: "dotnet-datetime", matches: (command) => DOTNET_DATETIME.test(command) },
  { name: "set-date", matches: (command) => SET_DATE.test(command) },
  {
    name: "js-date",
    matches: (command) => JS_INLINE_RUNNER.test(command) && JS_CLOCK_EXPR.test(command),
  },
  {
    name: "python-datetime",
    matches: (command) => hasPythonInlineRunner(command) && PYTHON_CLOCK_EXPR.test(command),
  },
];

export function classifyCommand(command: string): ClockClassification {
  const visible = maskSearchPatterns(command);
  const matched = PATTERNS.filter((pattern) => pattern.matches(visible)).map((pattern) => pattern.name);
  return { isClockRead: matched.length > 0, matched };
}
