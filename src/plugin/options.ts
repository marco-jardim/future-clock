import { validateYears } from "../core/years";

export interface FutureClockOptions {
  years: number;
}

const DEFAULT_YEARS = 120;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(["years"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeRaw(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Parses the plugin options. The only accepted option is `years` (default 120),
 * validated by `validateYears` against the real current year.
 */
export function parseOptions(raw: unknown, realYear: number): FutureClockOptions {
  if (raw === undefined || raw === null) return { years: DEFAULT_YEARS };
  if (!isPlainObject(raw)) {
    throw new Error(
      `future-clock: options must be an object like { years: number }, got ${describeRaw(raw)}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`future-clock: unknown option ${key}; the only option is \`years\``);
    }
  }
  if (!("years" in raw) || raw.years === undefined) return { years: DEFAULT_YEARS };
  return { years: validateYears(raw.years, realYear) };
}
