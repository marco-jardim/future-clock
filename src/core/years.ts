import type { ShiftInput, ShiftResult } from "./types";

const MIN_ABS_YEARS = 3;
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

/** Horizontal whitespace between date parts (never crosses a line break). */
const SP = "[ \\t\\u00a0]+";

const MONTHS_EN =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

const MONTHS_PT =
  "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";

function describeValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}

/**
 * Validates the `years` option (D4): an integer with |years| >= 3 whose shifted
 * target years (realYear-1 .. realYear+1) stay within [1000, 9999].
 * Returns the validated integer or throws an Error with a clear message.
 */
export function validateYears(years: unknown, realYear: number): number {
  if (typeof years !== "number" || !Number.isInteger(years)) {
    throw new Error(
      `future-clock: option "years" must be an integer, got ${describeValue(years)}`,
    );
  }
  if (Math.abs(years) < MIN_ABS_YEARS) {
    throw new Error(
      `future-clock: option "years" must satisfy |years| >= ${MIN_ABS_YEARS}, got ${years}`,
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
    // 1. "Today's date:" / "Today's date is now:" line -> every target year on that line
    new RegExp(`^[ \\t]*Today['\u2019]s date(?: is now)?:[^\\r\\n]*`, "gim"),
    // 2. "current year is YYYY"
    new RegExp(`\\bcurrent${SP}year${SP}is:?${SP}${year}`, "gi"),
    // 3. ISO-ish "YYYY-MM-DD" (optionally followed by "T...")
    new RegExp(`(?<!\\d)(?:${yearAlt})-\\d{2}-\\d{2}`, "g"),
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
 * guarantees idempotency (a shifted year never falls back into the target set).
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
