import { describe, expect, test } from "bun:test";
import { classifyCommand } from "../../../src/core/classify";

interface PositiveCase {
  readonly command: string;
  readonly matched: readonly string[];
}

const positives: readonly PositiveCase[] = [
  { command: "Get-Date", matched: ["get-date"] },
  { command: "get-date -Format yyyy-MM-dd", matched: ["get-date"] },
  { command: 'pwsh -c "Get-Date -UFormat %s"', matched: ["get-date"] },
  { command: "powershell -Command Get-Date", matched: ["get-date"] },
  { command: "Get-Date | Format-List", matched: ["get-date"] },
  { command: "(Get-Date).Year", matched: ["get-date"] },
  { command: "$d = GET-DATE", matched: ["get-date"] },
  { command: "date", matched: ["date-command"] },
  { command: "date +%s", matched: ["date-command"] },
  { command: "date /t", matched: ["date-command"] },
  { command: "echo x; date", matched: ["date-command"] },
  { command: "echo x && DATE -u", matched: ["date-command"] },
  { command: "false || date", matched: ["date-command"] },
  { command: "ls | date", matched: ["date-command"] },
  { command: "echo $(date)", matched: ["date-command"] },
  { command: "ls -la\n  date +%Y", matched: ["date-command"] },
  { command: "[DateTime]::Now", matched: ["dotnet-datetime"] },
  { command: "[datetime]::UtcNow.ToString('o')", matched: ["dotnet-datetime"] },
  { command: "[System.DateTime]::Today", matched: ["dotnet-datetime"] },
  { command: 'pwsh -c "[DateTimeOffset]::Now.ToUnixTimeSeconds()"', matched: ["dotnet-datetime"] },
  { command: "[DateTimeOffset]::UtcNow", matched: ["dotnet-datetime"] },
  { command: 'Set-Date -Date "2020-01-01"', matched: ["set-date"] },
  { command: 'node -e "console.log(new Date().toISOString())"', matched: ["js-date"] },
  { command: 'node --eval "console.log(Date.now())"', matched: ["js-date"] },
  { command: "bun -e 'console.log(Date.now())'", matched: ["js-date"] },
  { command: 'bun --eval "console.log(new Date())"', matched: ["js-date"] },
  { command: 'deno eval "console.log(new Date())"', matched: ["js-date"] },
  { command: 'python -c "import datetime; print(datetime.datetime.now())"', matched: ["python-datetime"] },
  { command: 'python3 -c "from datetime import datetime; print(datetime.utcnow())"', matched: ["python-datetime"] },
  { command: 'py -c "import datetime; print(datetime.date.today())"', matched: ["python-datetime"] },
  { command: 'python -c "import time; print(time.time())"', matched: ["python-datetime"] },
  { command: "Get-Date; date", matched: ["get-date", "date-command"] },
];

const negatives: readonly string[] = [
  "git log",
  "git log --date=iso",
  "Get-ChildItem",
  "Get-Content date.txt",
  "echo update",
  "npm run update-date",
  "cat dates.csv",
  "Get-Item x | Select LastWriteTime",
  "$date = 1",
  "node script.js",
  'Write-Output "the date is"',
  "ls -la",
  "date.txt",
  "touch -date x; echo --date",
  "cat date",
  "Get-DateRange; Target-Date",
  "[DateTime]::Parse('2020-01-01')",
  'node -e "console.log(1)"',
  'echo "new Date() and Date.now()"',
  'python -c "print(1)"',
  "echo datetime.now time.time()",
  'git commit -m "update date"',
];

describe("classifyCommand — positives", () => {
  for (const { command, matched } of positives) {
    test(`detects ${JSON.stringify(command)}`, () => {
      const result = classifyCommand(command);
      expect(result.isClockRead).toBe(true);
      expect([...result.matched]).toEqual([...matched]);
    });
  }
});

describe("classifyCommand — negatives", () => {
  for (const command of negatives) {
    test(`ignores ${JSON.stringify(command)}`, () => {
      const result = classifyCommand(command);
      expect(result.isClockRead).toBe(false);
      expect([...result.matched]).toEqual([]);
    });
  }
});

describe("classifyCommand — robustness", () => {
  test("handles long pathological input without blowing up", () => {
    const hostile = `${" ".repeat(20_000)}${"(".repeat(20_000)}${"\n".repeat(20_000)}[${" ".repeat(20_000)}`;
    expect(classifyCommand(hostile).isClockRead).toBe(false);
  });

  test("empty command is not a clock read", () => {
    expect(classifyCommand("")).toEqual({ isClockRead: false, matched: [] });
  });
});
