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
  // QA-1 m6: already-supported forms, kept as regression guards.
  { command: 'Get-Date -Format "yyyy-MM-dd"', matched: ["get-date"] },
  { command: "(Get-Date).ToString()", matched: ["get-date"] },
  { command: "[datetime]::Now.ToString('o')", matched: ["dotnet-datetime"] },
  // QA-1 m6: shell wrappers invoking `date`.
  { command: "cmd /c date /t", matched: ["date-command"] },
  { command: 'cmd.exe /d /c "date /t"', matched: ["date-command"] },
  { command: 'cmd /c "echo x & date /t"', matched: ["date-command"] },
  { command: 'bash -c "date +%Y"', matched: ["date-command"] },
  { command: "bash -lc 'echo hi; date -u'", matched: ["date-command"] },
  { command: "sh -c date", matched: ["date-command"] },
  { command: "/usr/bin/bash --norc -c 'date'", matched: ["date-command"] },
  { command: "wsl date", matched: ["date-command"] },
  { command: "wsl -d Ubuntu -- date +%F", matched: ["date-command"] },
  { command: 'wsl -e bash -c "date"', matched: ["date-command"] },
  { command: 'pwsh -NoProfile -Command "echo x; date"', matched: ["date-command"] },
  { command: 'grep "$(date +%Y)" app.log', matched: ["date-command"] },
  { command: 'echo "today: $(date)"', matched: ["date-command"] },
  // QA-1 m6: cmd.exe %DATE% expansion.
  { command: 'cmd /c "echo %DATE%"', matched: ["cmd-date-var"] },
  { command: "echo %date%", matched: ["cmd-date-var"] },
  { command: "echo %DATE:~-4%", matched: ["cmd-date-var"] },
  // QA-1 m6: Python flags before `-c` and time.* clock functions.
  { command: 'py -3 -c "import datetime; print(datetime.datetime.now())"', matched: ["python-datetime"] },
  { command: 'python -X utf8 -c "import datetime; print(datetime.date.today())"', matched: ["python-datetime"] },
  { command: "python -c \"import time; print(time.strftime('%Y'))\"", matched: ["python-datetime"] },
  { command: 'python3 -c "import time; print(time.localtime())"', matched: ["python-datetime"] },
  { command: 'python -c "import time; print(time.ctime())"', matched: ["python-datetime"] },
  { command: 'python -c "import time; print(time.asctime())"', matched: ["python-datetime"] },
  { command: 'python -I -B -c "import time; print(time.gmtime())"', matched: ["python-datetime"] },
  { command: 'C:\\Python312\\python.exe -c "import datetime; print(datetime.datetime.now())"', matched: ["python-datetime"] },
  { command: "bash -c \"python3 -c 'import time; print(time.time())'\"", matched: ["python-datetime"] },
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
  // QA-1 m7: quoted search patterns are not executed.
  'rg "Get-Date" src',
  'grep -r "Get-Date" .',
  "Select-String -Pattern 'Get-Date' -Path *.ps1",
  "sls 'Get-Date' x.ps1",
  'findstr /s "Get-Date" *.ps1',
  'git log -S "Get-Date"',
  'git grep "Get-Date"',
  'rg "Get-Date|date" src',
  'Get-ChildItem -Recurse *.ps1 | Select-String "[DateTime]::Now"',
  'grep -rn "date +%Y" scripts',
  'git -C repo grep -n "datetime.now()"; python -c "print(1)"',
  // QA-1 m7: `(` preceded by a word character does not start a command.
  'python -c "date = 5; print(date)"',
  // Wrappers and runners that do not read the clock.
  "cmd /c echo date",
  'bash -c "echo date"',
  "bash script.sh",
  "wsl --list --verbose",
  "wsl -d Ubuntu",
  'python script.py -c "datetime.now()"',
  "echo %dates%",
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

  test("handles long wrapper, quote and flag chains without blowing up", () => {
    const hostile = [
      "bash -c ".repeat(5_000),
      "cmd /c ".repeat(5_000),
      "wsl -d x ".repeat(5_000),
      "'\"".repeat(20_000),
      "py -X ".repeat(10_000),
      `git ${"-C x ".repeat(10_000)}grep "Get-Date"`,
      "%dat".repeat(20_000),
    ];
    for (const command of hostile) {
      expect(classifyCommand(command).isClockRead).toBe(false);
    }
  });

  test("empty command is not a clock read", () => {
    expect(classifyCommand("")).toEqual({ isClockRead: false, matched: [] });
  });
});
