import type { ShiftInput, ShiftResult } from "./types";

/**
 * Smallest accepted positive / largest accepted negative offset (D4).
 * Idempotency must survive a real-year change between two events: text shifted
 * with real year Y (targets Y-1..Y+1) is re-read with real year Y+1 (targets
 * Y..Y+2). A shifted year never lands in the next target set iff
 * Y-1+years > Y+2 (years >= 4) or Y+1+years < Y-1 (years <= -3).
 */
const MIN_POSITIVE_YEARS = 4;
const MAX_NEGATIVE_YEARS = -3;
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

/** Horizontal whitespace between date parts (never crosses a line break). */
const SP = "[ \\t\\u00a0]+";

const MONTHS_EN =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

const MONTHS_PT =
  "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";

const WEEKDAYS_EN =
  "Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?";

const WEEKDAYS_PT =
  "(?:segunda|ter[çc]a|quarta|quinta|sexta)(?:-feira)?|s[áa]bado|domingo";

/**
 * One word of a date as written after "Today's date:" — a number (optionally
 * "-", "/" or "." separated, optionally ordinal) or a month/weekday name or
 * the Portuguese "de". Never contains whitespace, so a run of these separated
 * by mandatory whitespace splits in exactly one way (linear matching).
 */
const DATE_WORD =
  `(?:\\d{1,4}(?:[-/.]\\d{1,4}){0,2}(?:st|nd|rd|th|\\u00ba)?` +
  `|(?:${MONTHS_EN}|${WEEKDAYS_EN}|${MONTHS_PT}|${WEEKDAYS_PT}|de)\\.?)(?!\\w)`;

/** A role "system" day-rollover notice line (D10): only these lines are shifted there. */
export const ROLLOVER_LINE = /^[ \t]*Today['\u2019]s date is now:/i;

function describeValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}

/**
 * Validates the `years` option (D4): an integer with years >= 4 or years <= -3
 * (idempotent even when the real year changes between events) whose shifted
 * target years (realYear-1 .. realYear+1) stay within [1000, 9999].
 * Returns the validated integer or throws an Error with a clear message.
 */
export function validateYears(years: unknown, realYear: number): number {
  if (typeof years !== "number" || !Number.isInteger(years)) {
    throw new Error(
      `future-clock: option "years" must be an integer, got ${describeValue(years)}`,
    );
  }
  if (years < MIN_POSITIVE_YEARS && years > MAX_NEGATIVE_YEARS) {
    throw new Error(
      `future-clock: option "years" must satisfy years >= ${MIN_POSITIVE_YEARS} or ` +
        `years <= ${MAX_NEGATIVE_YEARS} (idempotent across a real-year change), got ${years}`,
    );
  }
  const lowest = realYear - 1 + years;
  const highest = realYear + 1 + years;
  if (highest > MAX_YEAR || lowest < MIN_YEAR) {
    throw new Error(
      `future-clock: option "years" = ${years} would shift years ${realYear - 1}..${realYear + 1} ` +
        `to ${lowest}..${highest}, outside [${MIN_YEAR}, ${MAX_YEAR}]`,
    );
  }
  return years;
}

/** Date-shaped spans (D6, mode "context"). Each regex embeds the target-year alternation. */
function contextPatterns(yearAlt: string): RegExp[] {
  const year = `(?:${yearAlt})(?!\\d)`;
  return [
    // 1. "Today's date:" / "Today's date is now:" line -> only the date right after the colon
    new RegExp(
      `^[ \\t]*Today['\u2019]s date(?: is now)?:[ \\t\\u00a0]*${DATE_WORD}(?:,?${SP}${DATE_WORD})*`,
      "gim",
    ),
    // 2. "current year is YYYY"
    new RegExp(`\\bcurrent${SP}year${SP}is:?${SP}${year}`, "gi"),
    // 3. ISO "YYYY-MM-DD" with a valid month/day, not followed by a digit (may be followed by "T...")
    new RegExp(
      `(?<!\\d)(?:${yearAlt})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?!\\d)`,
      "g",
    ),
    // 4. English "Oct 12 YYYY" / "October 12, YYYY" (weekday, if any, precedes the match)
    new RegExp(`\\b(?:${MONTHS_EN})\\.?${SP}\\d{1,2}(?:st|nd|rd|th)?,?${SP}${year}`, "gi"),
    // 4b. English "12 October YYYY"
    new RegExp(`(?<!\\d)\\d{1,2}${SP}(?:${MONTHS_EN})\\.?,?${SP}${year}`, "gi"),
    // 5. Portuguese "12 de outubro de YYYY"
    new RegExp(`(?<!\\d)\\d{1,2}\u00ba?${SP}de${SP}(?:${MONTHS_PT})${SP}de${SP}${year}`, "gi"),
    // 6. numeric "dd/mm/YYYY" or "mm/dd/YYYY" ("/", "." or "-", same separator twice)
    new RegExp(`(?<!\\d)\\d{1,2}([/.-])\\d{1,2}\\1${year}`, "g"),
  ];
}

/**
 * Shifts target years {realYear-1, realYear, realYear+1} by `years` (D5/D6).
 * Pure: no Date usage. `years` is expected to have passed `validateYears`, which
 * guarantees idempotency (a shifted year never falls back into the target set,
 * not even for the next real year).
 */
export function shiftYears(input: ShiftInput): ShiftResult {
  const { text, realYear, years, mode } = input;
  const targets = new Set<string>([realYear - 1, realYear, realYear + 1].map(String));
  const yearAlt = [...targets].join("|");
  let count = 0;

  const shift = (token: string): string => {
    if (!targets.has(token)) return token;
    count += 1;
    return String(Number(token) + years);
  };

  let out: string;
  if (mode === "clock") {
    // Every digit-delimited target year, plus the 4-digit prefix of compact
    // runs of exactly 8, 12 or 14 digits (yyyyMMdd[HHmm[ss]]).
    const clockRe = new RegExp(`(?<!\\d)(${yearAlt})(\\d{10}|\\d{8}|\\d{4})?(?!\\d)`, "g");
    out = text.replace(
      clockRe,
      (_match: string, year: string, rest: string | undefined): string =>
        shift(year) + (rest ?? ""),
    );
  } else {
    const tokenRe = new RegExp(`(?<!\\d)(?:${yearAlt})(?!\\d)`, "g");
    out = text;
    for (const pattern of contextPatterns(yearAlt)) {
      out = out.replace(pattern, (span: string): string => span.replace(tokenRe, shift));
    }
  }

  return { text: count === 0 ? text : out, count };
}

/**
 * Context-mode shifting restricted to day-rollover notice lines (D10): only
 * lines matching `ROLLOVER_LINE` are shifted; every other line (split on "\n",
 * a trailing "\r" stays with its line) is returned byte-identical.
 */
export function shiftRolloverLines(text: string, realYear: number, years: number): ShiftResult {
  let count = 0;
  const lines = text.split("\n").map((line: string): string => {
    if (!ROLLOVER_LINE.test(line)) return line;
    const result = shiftYears({ text: line, realYear, years, mode: "context" });
    count += result.count;
    return result.text;
  });
  return { text: count === 0 ? text : lines.join("\n"), count };
}
