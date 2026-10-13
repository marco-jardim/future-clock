# Preflight decisions (D-PF1..9)

| ID | Decision |
|----|----------|
| D-PF1 | Adopted L1 (project-level plugin entry, last in the array) + L3 (final pass in `http.request`). L2 (re-anchor) NOT implemented (L3 is viable). |
| D-PF2 | L3 detects the wire format by BODY SHAPE (JSON with a `messages` array + `system`), not by URL, because anthropic-fix rewrites the URL to a local bridge before our hook runs. The replacement must preserve url, method, headers (incl. the ticket header) and signal; drop `content-length`; streaming bodies are read via `clone().text()`. |
| D-PF3 | Only the Anthropic Messages adapter (the provider in use). Unknown body → left untouched + a single warning (warn once). |
| D-PF4 | Sandbox root `D:\future-sandbox`; isolation = `XDG_CONFIG_HOME` + `--standalone`; E6 runs with the real config (no XDG override). |
| D-PF5 | Plugin shipped as the directory `dist\future-clock\` {`package.json`, `server.js`}; the build script must produce this (the plan's single-file `dist\future-clock.js` is replaced). |
| D-PF6 | Default model `opencode-go/claude-haiku-5-5`. |
| D-PF7 | Linear not used (no `.env` in the repo). |
| D-PF8 | Known probe-runner problem: EBUSY when recreating directories watched by the background service; some runs (S-mutate, S-real) ran without `opencode.json` and were redone manually (S-mutate2, S-real2). Not fixed (probe tooling, replaced by `sandbox.ts` in Phase 2). |
| D-PF9 | Rollover rewrite: only lines that start with `Today's date is now:` inside `system` role messages (context hook) / message text blocks (L3); user messages remain untouched. |
| D-QA1 | The `years` minimum becomes `years >= 4 \|\| years <= -3` (previously `\|years\| >= 3`), for idempotence when the real year rolls over between events (QA-1 m1). |
| D-QA2 | The L3 boundary rewrites in messages only `Today's date is now:` lines from user/system; assistant text is never touched (QA-1 m2). |
| D-QA2-1 | `cleanup` deletes targets beyond the plan: also `D:\future-probe` and `probe\dist` (pre-flight scratch). `runs` and `dumps` are preserved. |
| D-QA2-2 | E5 asserts on the response text (the control has no plugin, hence no dumps). |
| D-QA2-3 | E6 asserts the router sentinel ("Role Delegation Protocol") only in parent-session bodies (the router injects only into the orchestrator); child sessions are verified as shifted. Identity of the router text against a no-plugin baseline is NOT tested end to end: it is covered by the unit test `coexistence.test.ts`. |
| D-QA2-4 | `run-e2e` is a single-shot execution (not resumable); output goes to a log file, with a summary of ≤4 KiB on stdout. |
| D-QA2-5 | `runEnv` strips `INIT_CWD`/`PWD`/`OLDPWD`/`npm_*`/`NODE`/`NODE_ENV`/`OPENCODE*` from the parent so opencode starts in the sandbox. |
| D-QA2-6 | D13 (secrets) scan implemented for dumps (e2e) and for versioned files (`test/unit/secrets.test.ts`), excluding `docs/plans/*.md`. |
| D-QA2-7 | Cost gate §7.1 (≤50 sessions) exceeded: ~3 e2e runs × 7 + reruns + 32 experiment runs (+ subagent children) ≈ 70 sessions on `opencode-go/claude-haiku-5-5` (a low-cost model). Accepted. |
