import { describe, expect, test } from "bun:test";
import { shiftRolloverLines, shiftYears, validateYears } from "../../../src/core/years";
import type { Mode, ShiftResult } from "../../../src/core/types";

const REAL_YEAR = 2026;
const YEARS = 120;

function run(mode: Mode, text: string, years: number = YEARS, realYear: number = REAL_YEAR): ShiftResult {
  return shiftYears({ text, realYear, years, mode });
}
const ctx = (text: string, years?: number, realYear?: number): ShiftResult =>
  run("context", text, years, realYear);
const clk = (text: string, years?: number, realYear?: number): ShiftResult =>
  run("clock", text, years, realYear);

// Real outputs captured from pwsh on 2026-10-12 (en-US and pt-BR cultures).
const EN_GET_DATE = "Monday, October 12, 2026 4:03:43 PM";
const EN_FORMAT_O = "2026-10-12T16:03:43.9942691-03:00";
const EN_YEAR = "2026";
const EN_COMPACT = "20261012";
const EN_TOSTRING = "10/12/2026 4:03:47 PM";
const PT_GET_DATE = "segunda-feira, 12 de outubro de 2026 16:03:48";
const PT_TOSTRING = "12/10/2026 16:03:52";
const FL_DATE = "\u001b[32;1mDate : \u001b[0m12/10/2026 00:00:00";
const FL_YEAR = "Year : 2026";

describe("validateYears", () => {
  test("accepts integers with years >= 4 or years <= -3 inside [1000, 9999]", () => {
    expect(validateYears(120, REAL_YEAR)).toBe(120);
    expect(validateYears(-120, REAL_YEAR)).toBe(-120);
    expect(validateYears(4, REAL_YEAR)).toBe(4);
    expect(validateYears(-3, REAL_YEAR)).toBe(-3);
    expect(validateYears(7972, REAL_YEAR)).toBe(7972); // 2027 + 7972 = 9999
    expect(validateYears(-1025, REAL_YEAR)).toBe(-1025); // 2025 - 1025 = 1000
  });

  test("rejects non-integers, -3 < years < 4 and out-of-range results", () => {
    const range = /years >= 4 or years <= -3/;
    expect(() => validateYears(3, REAL_YEAR)).toThrow(range);
    expect(() => validateYears(2, REAL_YEAR)).toThrow(range);
    expect(() => validateYears(0, REAL_YEAR)).toThrow(range);
    expect(() => validateYears(1, REAL_YEAR)).toThrow(range);
    expect(() => validateYears(-2, REAL_YEAR)).toThrow(range);
    expect(() => validateYears(2.5, REAL_YEAR)).toThrow(/integer/);
    expect(() => validateYears("120", REAL_YEAR)).toThrow(/integer/);
    expect(() => validateYears(Number.NaN, REAL_YEAR)).toThrow(/integer/);
    expect(() => validateYears(undefined, REAL_YEAR)).toThrow(/integer/);
    expect(() => validateYears(7974, REAL_YEAR)).toThrow(/outside \[1000, 9999\]/);
    expect(() => validateYears(7973, REAL_YEAR)).toThrow(/outside \[1000, 9999\]/);
    expect(() => validateYears(-1026, REAL_YEAR)).toThrow(/outside \[1000, 9999\]/);
  });
});

describe('shiftYears mode "context"', () => {
  test("Today's date line", () => {
    expect(ctx("Today's date: Mon Oct 12 2026")).toEqual({
      text: "Today's date: Mon Oct 12 2146",
      count: 1,
    });
    expect(ctx("Today's date is now: Tue Oct 13 2026")).toEqual({
      text: "Today's date is now: Tue Oct 13 2146",
      count: 1,
    });
  });

  test("Today's date line: only the date right after the colon changes (N1)", () => {
    expect(ctx("Today's date: Mon Oct 12 2026 | protocol v2026")).toEqual({
      text: "Today's date: Mon Oct 12 2146 | protocol v2026",
      count: 1,
    });
    expect(ctx("Today's date: Mon Oct 12 2026 protocol v2026 build 2026")).toEqual({
      text: "Today's date: Mon Oct 12 2146 protocol v2026 build 2026",
      count: 1,
    });
    // a shape only this pattern covers ("yyyy/mm/dd"), followed by a non-date tail
    expect(ctx("Today's date: 2026/10/12 (release 2026)")).toEqual({
      text: "Today's date: 2146/10/12 (release 2026)",
      count: 1,
    });
    expect(ctx("today\u2019s date is now: Tuesday, October 13th, 2026")).toEqual({
      text: "today\u2019s date is now: Tuesday, October 13th, 2146",
      count: 1,
    });
    expect(ctx("Today's date: segunda-feira, 12 de outubro de 2026")).toEqual({
      text: "Today's date: segunda-feira, 12 de outubro de 2146",
      count: 1,
    });
    // no date right after the colon: nothing on the line is date-shaped
    expect(ctx("Today's date: see v2026 notes")).toEqual({
      text: "Today's date: see v2026 notes",
      count: 0,
    });
  });

  test("current year is YYYY", () => {
    expect(ctx("The current year is 2026. Use this year...")).toEqual({
      text: "The current year is 2146. Use this year...",
      count: 1,
    });
  });

  test("years outside date-shaped patterns stay untouched", () => {
    for (const text of [
      "version 2026 of the spec",
      "ISO 2026 standard",
      "2026 items",
      "build 20261012",
      "in 2026, things changed",
    ]) {
      expect(ctx(text)).toEqual({ text, count: 0 });
    }
  });

  test("ISO-ish dates, including Dec->Jan neighbours and non-target years", () => {
    expect(ctx("**2026-10-12**")).toEqual({ text: "**2146-10-12**", count: 1 });
    expect(ctx(EN_FORMAT_O).text).toBe("2146-10-12T16:03:43.9942691-03:00");
    expect(ctx("2027-01-03")).toEqual({ text: "2147-01-03", count: 1 });
    expect(ctx("2025-12-30")).toEqual({ text: "2145-12-30", count: 1 });
    expect(ctx("2028-01-01")).toEqual({ text: "2028-01-01", count: 0 });
    expect(ctx("2024-12-31")).toEqual({ text: "2024-12-31", count: 0 });
  });

  test("ISO dates need a valid month/day and no trailing digit (N1)", () => {
    for (const text of [
      "INC-2026-01-0042",
      "2026-13-45",
      "2026-10-12345",
      "2026-00-10",
      "2026-10-00",
      "2026-10-32",
    ]) {
      expect(ctx(text)).toEqual({ text, count: 0 });
    }
    expect(ctx("2026-10-12_14-30")).toEqual({ text: "2146-10-12_14-30", count: 1 });
    expect(ctx("2026-01-31 2027-12-01")).toEqual({ text: "2146-01-31 2147-12-01", count: 2 });
  });

  test("English, Portuguese and numeric date forms", () => {
    expect(ctx(EN_GET_DATE).text).toBe("Monday, October 12, 2146 4:03:43 PM");
    expect(ctx("12 October 2026").text).toBe("12 October 2146");
    expect(ctx("Sept. 3rd, 2027").text).toBe("Sept. 3rd, 2147");
    expect(ctx(PT_GET_DATE).text).toBe("segunda-feira, 12 de outubro de 2146 16:03:48");
    expect(ctx("1 de março de 2027").text).toBe("1 de março de 2147");
    expect(ctx("5 DE MARÇO DE 2025").text).toBe("5 DE MARÇO DE 2145");
    expect(ctx(EN_TOSTRING).text).toBe("10/12/2146 4:03:47 PM");
    expect(ctx(PT_TOSTRING).text).toBe("12/10/2146 16:03:52");
    expect(ctx("12.10.2026 and 12-10-2026")).toEqual({
      text: "12.10.2146 and 12-10-2146",
      count: 2,
    });
    // mixed separators are not a date shape
    expect(ctx("12/10-2026").count).toBe(0);
  });

  test("multiline prompt: only date-shaped years change, CRLF preserved", () => {
    const input =
      "Here is useful information\r\n" +
      "Today's date: Mon Oct 12 2026\r\n" +
      "Spec version 2026 released 2026-10-12.\r\n" +
      "Copyright 2025\r\n";
    expect(ctx(input)).toEqual({
      text:
        "Here is useful information\r\n" +
        "Today's date: Mon Oct 12 2146\r\n" +
        "Spec version 2026 released 2146-10-12.\r\n" +
        "Copyright 2025\r\n",
      count: 2,
    });
  });
});

describe('shiftYears mode "clock"', () => {
  test("real en-US outputs", () => {
    expect(clk(EN_GET_DATE)).toEqual({ text: "Monday, October 12, 2146 4:03:43 PM", count: 1 });
    expect(clk(EN_FORMAT_O)).toEqual({ text: "2146-10-12T16:03:43.9942691-03:00", count: 1 });
    expect(clk(EN_YEAR)).toEqual({ text: "2146", count: 1 });
    expect(clk(EN_COMPACT)).toEqual({ text: "21461012", count: 1 });
    expect(clk(EN_TOSTRING)).toEqual({ text: "10/12/2146 4:03:47 PM", count: 1 });
  });

  test("real pt-BR outputs and Format-List with ANSI escapes", () => {
    expect(clk(PT_GET_DATE).text).toBe("segunda-feira, 12 de outubro de 2146 16:03:48");
    expect(clk(PT_TOSTRING).text).toBe("12/10/2146 16:03:52");
    expect(clk(FL_DATE)).toEqual({
      text: "\u001b[32;1mDate : \u001b[0m12/10/2146 00:00:00",
      count: 1,
    });
    expect(clk(FL_YEAR)).toEqual({ text: "Year : 2146", count: 1 });
    const block = `\r\n${FL_DATE}\r\n\u001b[32;1m${FL_YEAR}\r\n\r\n`;
    expect(clk(block)).toEqual({
      text: "\r\n\u001b[32;1mDate : \u001b[0m12/10/2146 00:00:00\r\n\u001b[32;1mYear : 2146\r\n\r\n",
      count: 2,
    });
  });

  test("compact runs of 8/12/14 digits and non-digit delimiters", () => {
    expect(clk("20261012").text).toBe("21461012");
    expect(clk("202610121430").text).toBe("214610121430");
    expect(clk("20261012143000").text).toBe("21461012143000");
    expect(clk("2026-10-12_14-30").text).toBe("2146-10-12_14-30");
    expect(clk("log-2026.txt").text).toBe("log-2146.txt");
    expect(clk("v2026x_2027").text).toBe("v2146x_2147");
    expect(clk("version 2026 of the spec").text).toBe("version 2146 of the spec");
  });

  test("other numbers stay untouched", () => {
    for (const text of [
      "1791832078", // epoch seconds
      "20261", // 5 digits
      "2026101", // 7 digits
      "2026101214", // 10 digits
      "120261012", // 9 digits
      "2028 2024 1999",
    ]) {
      expect(clk(text)).toEqual({ text, count: 0 });
    }
  });

  test("text without years is returned unchanged", () => {
    const text = "hello world 123 4567\r\nno dates here";
    const result = clk(text);
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
    expect(ctx(text)).toEqual({ text, count: 0 });
  });

  test("negative years", () => {
    expect(clk("2026", -120)).toEqual({ text: "1906", count: 1 });
    expect(clk("2025 2027", -120).text).toBe("1905 1907");
    expect(ctx("Today's date: Mon Oct 12 2026", -120).text).toBe("Today's date: Mon Oct 12 1906");
  });
});

describe("idempotency", () => {
  const corpus = [
    EN_GET_DATE,
    EN_FORMAT_O,
    EN_YEAR,
    EN_COMPACT,
    EN_TOSTRING,
    PT_GET_DATE,
    PT_TOSTRING,
    FL_DATE,
    FL_YEAR,
    "Today's date: Mon Oct 12 2026\r\nThe current year is 2026.\r\n2027-01-03 2025-12-30",
    "202610121430 20261012143000 2026-10-12_14-30 log-2026.txt",
  ];

  for (const mode of ["context", "clock"] as const) {
    test(`${mode}: applying twice equals applying once`, () => {
      for (const years of [YEARS, -120, 4, -3]) {
        for (const text of corpus) {
          const once = run(mode, text, years);
          const twice = run(mode, once.text, years);
          if (mode === "clock") expect(once.count).toBeGreaterThan(0);
          expect(twice.text).toBe(once.text);
          expect(twice.count).toBe(0);
        }
      }
    });

    test(`${mode}: re-applying after the real year changed (Y then Y+1) changes nothing`, () => {
      for (const years of [4, YEARS, -3, -120]) {
        for (const text of corpus) {
          const once = run(mode, text, years, REAL_YEAR);
          const next = run(mode, once.text, years, REAL_YEAR + 1);
          expect(next).toEqual({ text: once.text, count: 0 });
        }
      }
    });
  }

  test("years = 4: a year shifted under 2026 is not a target under 2027 (m1)", () => {
    expect(ctx("2026-12-30", 4, 2026)).toEqual({ text: "2030-12-30", count: 1 });
    expect(ctx("2030-12-30", 4, 2027)).toEqual({ text: "2030-12-30", count: 0 });
    expect(clk("2030-12-30", 4, 2027)).toEqual({ text: "2030-12-30", count: 0 });
  });
});

describe("shiftRolloverLines", () => {
  test("shifts only the rollover line, every other line byte-identical (m3)", () => {
    expect(
      shiftRolloverLines(
        "Instructions updated.\nFreeze 2026-12-20.\nToday's date is now: Tue Oct 13 2026",
        REAL_YEAR,
        YEARS,
      ),
    ).toEqual({
      text: "Instructions updated.\nFreeze 2026-12-20.\nToday's date is now: Tue Oct 13 2146",
      count: 1,
    });
  });

  test("keeps CRLF, accepts indentation, curly apostrophe and any case", () => {
    const input =
      "Freeze 2026-12-20.\r\n  today\u2019s date is now: 2026-10-13\r\nThe current year is 2026.\r\n";
    expect(shiftRolloverLines(input, REAL_YEAR, YEARS)).toEqual({
      text:
        "Freeze 2026-12-20.\r\n  today\u2019s date is now: 2146-10-13\r\nThe current year is 2026.\r\n",
      count: 1,
    });
  });

  test("leaves non-rollover text (including plain Today's date:) untouched", () => {
    for (const text of [
      "Today's date: Mon Oct 12 2026",
      "Note: Today's date is now: Tue Oct 13 2026",
      "Release on 2026-10-12.\nThe current year is 2026.",
      "",
    ]) {
      const result = shiftRolloverLines(text, REAL_YEAR, YEARS);
      expect(result).toEqual({ text, count: 0 });
      expect(result.text).toBe(text);
    }
  });

  test("is idempotent and supports negative offsets", () => {
    const once = shiftRolloverLines("x\nToday's date is now: Tue Oct 13 2026", REAL_YEAR, -120);
    expect(once).toEqual({ text: "x\nToday's date is now: Tue Oct 13 1906", count: 1 });
    expect(shiftRolloverLines(once.text, REAL_YEAR, -120)).toEqual({ text: once.text, count: 0 });
    expect(shiftRolloverLines(once.text, REAL_YEAR + 1, -120)).toEqual({
      text: once.text,
      count: 0,
    });
  });
});
