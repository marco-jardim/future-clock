# E2E report — end-to-end verification of future-clock

Actual execution date: 2026-10-12. Simulated date (`years: 120`): 2146.

## Environment

- opencode v2.0.27 (scoop), Bun 1.3.14, Windows / pwsh 7.6.6
- Model: `opencode-go/claude-haiku-5-5`
- Plugin: `dist\future-clock` with `{years:120}`
- Sandbox: `D:\future-sandbox` (git init, `notes.txt` with "Nota criada em 2026-10-12.")
- Isolation: `XDG_CONFIG_HOME=%TEMP%\Claude\future-artifacts\iso\xdg-config` + `--standalone`
- Dumps via `FUTURE_CLOCK_DUMP_DIR`

## Result

Run 3 (`bun run test:e2e`): **7 pass, 0 fail — COMPLETE**.

| Test | Scenario | Evidence |
|---|---|---|
| E0 | Isolation | 1 primary dump; no sentinels (Sisyphus / Role Delegation Protocol absent); "Today's date: Mon Oct 12 2146" |
| E1 | Date in the system prompt | "Today's date: Mon Oct 12 2146" in the system; model response with 2146 |
| E2 | Tools (shell/read) | 3 primary dumps; shell tool_result "segunda-feira, 12 de outubro de 2146 19:46:57"; the read tool_result kept "Nota criada em 2026-10-12" (out of scope, untouched) |
| E3 | websearch description | "The current year is 2146" |
| E4 | Subagent | 4 dumps from 2 sessions (parent + subagent); in the subagent, system with 2146 and Get-Date "segunda-feira, 12 de outubro de 2146 19:47:08" |
| E5 | Control (no plugin, no dumps) | Response with the real year 2026; no 2146 |
| E6 | Real global config, prompt forcing subagent + shell | Router sentinel ("Role Delegation Protocol") present in the parent-session body; ≥2 sessions; child bodies shifted (2146); no real year in date form in system/descriptions; no "[future-clock] … failed" in stderr; plugin load log captured (`--print-logs`) |

Run 4 (after the QA-2 fixes): **7/7 pass**. The first attempt failed on 2 overly strict asserts (E2: the response legitimately cited the 2026 from `notes.txt`; E6: router sentinel expected in child sessions as well), fixed in the commit "test(e2e): asserções E2/E6 alinhadas ao comportamento real".

Cross-cutting checks E7/E8 (no real year in date form in system/descriptions; no secrets in the dumps) apply to E0, E1, E2, E4 and E6 — not to E3 (reuses E1 bodies) nor E5 (no dumps). E1, E2 and E4 also assert `.l3.json` with `changed===0` (the hooks did the work before the boundary).

## History

Runs 1–2 failed (0 dumps in E0/E1/E6; E2/E4 inconclusive). Cause: `bun run` injected `INIT_CWD`/`npm_*` and the parent process (an opencode session) passed `OPENCODE_*`. The child opencode started in `D:\git\future-agents` instead of the sandbox and did not load the plugin. Fixed in the commit "fix(runner): não herdar INIT_CWD/npm_*/OPENCODE_* do processo pai". Run 3 = 7/7.

## Limitation

The anthropic-fix path (local bridge, streaming body, ticket header) is only covered by a simulated unit test, because the model used (opencode-go) is not intercepted by it.
