# Plan — `future-clock` plugin (opencode v2): the model "lives" N years in the future

- **Date:** 2026-10-12 · **Revision:** 4 (lean)
- **Repository:** `D:\git\future-agents` (branch `main`) · **Platform:** win32, pwsh 7
- **Target:** **opencode v2 only** (2.0.x line). v1 is not supported.
- **User decisions:**
  - scope is "just the clock";
  - **single configuration: `years`**;
  - **swap only the year**;
  - coexistence with other plugins (including the model-router), with `future-clock` applied **last**;
  - **isolated** comparative experiment;
  - fewer tests, driven by ROI.

---

## 0. Execution directives (READ FIRST)

### 0.1 Continuous execution
Execute **from start to finish, wave after wave, without interruption**. Stop and ask the human **only** in four cases:
- (a) an ambiguity the plan does not resolve and whose options differ by 2x+ in effort or in observable behavior;
- (b) a critical problem or a **BLOCKER** listed in the plan;
- (c) §0.6 exhausted;
- (d) `router_run` refuses a command that has no equivalent script (§0.7).

In all other cases, apply the plan's decision rule, record it through the scribe (§0.8), and move on.

### 0.2 Definitive solution
Every phase delivers the **definitive** solution for its sub-goal. Stubs, TODOs, and "complete later" are not accepted.

### 0.3 Safe parallelism
1. **One writer per file.** Each task declares `OWNS`. Two agents never own the same file.
2. **No reading of files being edited.** `READS` only points to **frozen** files (owning task finished and verified).
3. **Parallel task checks touch only their own tests.** Use `check: testsPass` (the router runs only the affected tests) or `bun test <your files>`. Typecheck and the full suite run **only at join points**, by a `runner`.
4. **Shared files are serialized.** `D:\git\future-agents\package.json`, `D:\git\future-agents\tsconfig.json`, `D:\git\future-agents\.gitignore`, and `D:\git\future-agents\src\core\types.ts` belong to bootstrap B.1 and freeze after it. A later change is an isolated task, dispatched alone.
5. A parallel step (`∥`) is dispatched in a single message. The next step only goes out after the join checkpoint: `bun run typecheck` → `bun run test` → `bun run commit`.

### 0.4 Commit often (queue)
- **Nobody runs git directly.** The last subtask of each task writes `D:\git\future-agents\.tmp\commits\<task-id>.json` = `{ "message": "...", "paths": ["..."] }`.
- At the join, a `runner` executes `bun run commit`. The script `D:\git\future-agents\scripts\git\commit.ts` processes the queue in order. For each item:
  1. validates Conventional Commits;
  2. **rejects** `Co-Authored-By` and "Generated with";
  3. runs `git add -- <paths>` for the listed paths only;
  4. runs `git commit -F`;
  5. deletes the item.

  The script stops at the first failure.
- Commit **per task**, **per QA fix**, and **per evidence update**. Never push without being asked; never force push.
- Pass this on to every delegate: AI trailers are **forbidden** (`Co-Authored-By` from any model, "Generated with ...").

### 0.5 Model-router annotations
- **Role** + **route line** (first line of the dispatch, literal) + `[acceptance]` block + `VERIFY:required` (when something depends on the task) or `deferred`.
- **`[tier:heavy]` appears only on QA steps** (route with `tier=heavy pin`). **QA is always heavy**, including re-reviews. No other task pins a tier.
- Every dispatch prompt has: route line, TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT (`Working directory is D:\git\future-agents. Platform: win32. Shell: pwsh.`), always with absolute paths.
- Access to `C:\Users\Marquinho\AppData\Local\Temp\Claude\` requires `needs=external_dir`. The first `bun install` requires `needs=network`.

### 0.6 QA and failure recovery
1. At the end of each phase, and at the end of the plan (QA-G), a `reviewer` `[tier:heavy]` performs an **adversarial review** and runs the checks with `router_run`. The reviewer **does not write files**: it delivers **attack specifications** (input, expected output, target file).
2. Findings are classified as `BLOCKER | MAJOR | MINOR | NIT`. **All are fixed.** A NIT can only be declined with a justification in `qa-log.md`.
3. An `implementer` fixes and turns each valid attack into a test. Then heavy re-review until **zero BLOCKER and zero MAJOR**.
4. After 3 cycles without converging, or 3 consecutive failures on the same problem: STOP, document in `qa-log.md`, and ask the human. Rollback is **per phase**, performed by the human or by an agent with an explicit tier.
5. Forbidden: `as any`, `@ts-ignore`, `@ts-expect-error`, empty catch, skipping or deleting a failing test, and shotgun debugging.

### 0.7 External processes
- git, opencode, environment capture, and the experiment run **only via `package.json` scripts**, executed by a `runner` with `router_run`. Scripts take no arguments; each variant is its own script.
- Long scripts (`probe`, `test:e2e`, `experiment`) are **resumable**:
  - each invocation processes up to 8 model runs;
  - saves state to `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\state\`;
  - prints at most 4 KiB and ends with `COMPLETE` when finished.

  The runner repeats the invocation until it sees `COMPLETE`.
- `router_run` strips environment variables that hold credentials, but credential files remain accessible. U11 checks whether `opencode run` authenticates under those conditions. If the command is refused or authentication fails, ask the human.

### 0.8 Evidence scribe
The files `D:\git\future-agents\docs\plans\evidence\preflight.md`, `decisions.md`, `qa-log.md`, and `e2e-report.md` have a **single writer**: the scribe. It is a `general` with the route `[route class=other risk=low scope=single needs=edit,external_dir root=D:\git\future-agents]`, dispatched only at join points and never in parallel with another scribe.

---

## 1. Goal

Opencode v2 plugin `future-clock` whose **only configuration** is:

```json
{ "plugins": [{ "package": "file:///D:/git/future-agents/dist/future-clock.js", "options": { "years": 120 } }] }
```

With it active, **the year** the model perceives as "now" becomes `real year + years`. Day, month, time, and day of the week stay as they are: `Today's date: Mon Oct 12 2026` becomes `Today's date: Mon Oct 12 2146`.

| # | Source of "now" | Where it is rewritten |
|---|---|---|
| S1 | `Today's date: …` line in the system prompt | `context` hook + final pass (L3) |
| S2 | Day-rollover line `Today's date is now: …` in the history | `context` hook + L3 |
| S3 | `The current year is YYYY` in tool descriptions | `context` hook + L3 |
| S4 | Output of clock-reading commands in the `shell` tool | `execute.after` hook + L3 |

**R-COEX:** the plugin coexists with other plugins, including the model-router, without breaking them. The content sent to the model reflects `future-clock`'s modifications **after** those of every other plugin.

**Non-goals:**
- opencode v1;
- shifting day, month, or day of the week;
- changing real effects (arguments, system clock, files);
- shifting web, files, `git log`, mtimes, epoch, or ticks;
- reversing dates typed by the model.

### 1.1 Design decisions

| ID | Decision |
|---|---|
| D1 | Bun + `tsc --noEmit` in strict mode. DevDeps at exact versions: `typescript`, `@types/bun`. No property tests and no coverage threshold. |
| D2 | v2 Promise API. The export shape is decided by U5: if `Plugin.define` is only a typing helper, use `import type` + a literal object; otherwise, a runtime import resolved by the host. If there is an `@opencode/plugin` devDep, it stays at the host's exact version (U1). |
| D3 | Single-file build at `D:\git\future-agents\dist\future-clock.js`, referenced via `file:///`. If U5 shows this fails, copy it to `<sandbox>\.opencode\plugins\`. |
| D4 | **Single option `years`**: integer with `years ≥ 4 or years ≤ −3` and resulting year in [1000, 9999]. Invalid → clear error in `setup`. Test instrumentation **is not configuration**: the env var `FUTURE_CLOCK_DUMP_DIR` enables the dump (D11). |
| D5 | **Year swap only.** Target years = `{Y−1, Y, Y+1}`, where Y is the real local year read **per event**, only in `D:\git\future-agents\src\plugin\index.ts`. Y±1 covers `AddMonths(±1)` at the year boundary. The core is pure: it receives `realYear` and `years`. **Idempotence:** since `years ≥ 4 or years ≤ −3`, a swapped year never falls back into the target set. |
| D6 | **Two modes.** **`context`** (system, descriptions, rollover line): the year is swapped only inside date-shaped patterns: `Today's date( is now)?:` line, `current year is YYYY`, ISO `YYYY-MM-DD…`, `Mon Oct 12 YYYY`, `October 12, YYYY`, `12 de outubro de YYYY`, `dd/mm/YYYY` / `mm/dd/YYYY`. **`clock`** (classified `shell` output): swaps **every** target-year token delimited by non-digits (`(?<!\d)YYYY(?!\d)`) and the prefix of compact 8-, 12-, or 14-digit sequences (`yyyyMMdd…`). |
| D7 | **Command classifier** for S4. Positives: `Get-Date` (including inside `pwsh -c`), `date` as a command, `[DateTime]::Now`, `[DateTime]::UtcNow`, `[DateTime]::Today`, `[DateTimeOffset]::Now`, `new Date(`/`Date.now(` in `node -e`/`bun -e`, `datetime.now`/`datetime.today` in `python -c`. |
| D8 | **Hooks never take the session down.** try/catch with logging (ctx logger or `console.error("[future-clock] …")`). The event proceeds untouched. |
| D9 | **"Last" (R-COEX).** Three layers: **L1** — `future-clock` goes last in the `plugins` array, or uses the priority option, if U13 reveals one; **L3** — final pass in the `http.request` hook: the serialized body is rewritten by the **adapter for the provider in use** (U4), applying D6 to the system prompt, descriptions, rollover line, and tool results whose matching `tool_use` is a classified `shell`; **L2** — re-registration of the hooks on the first event, implemented **only if L3 is infeasible**. **Decision rule:** L3 feasible → L3 is the guarantee. L3 infeasible, but L1/L2 guarantee the order → proceed and document. Neither → **BLOCKER**. If the model-router mutates the body after L3 and there is no way to beat it (U13/U14) → **BLOCKER**. |
| D10 | **Scope under coexistence.** In the system prompt and descriptions, `context` mode acts on **any part**, including other plugins' text, which stays byte-for-byte identical outside the swapped years. In messages, it acts only on the rollover line and on classified tool results. User messages are never touched. |
| D11 | **Dump + detector at the boundary**, after L3, active only with `FUTURE_CLOCK_DUMP_DIR`. The dump writes **only the body** to `<dir>\<sessionID>-<kind>-<seq>.json`, plus a sidecar `.l3.json` file with the number of fixes made by L3. **Never writes headers or URL.** The detector emits a warn if the real year appears in date form in the system prompt, descriptions, or classified tool results. L3's output is **deterministic**, to preserve the prompt cache. |
| D12 | **Isolation** (§3) in E0–E5 and in the experiment. E6 runs with the real global config, to exercise the model-router. |
| D13 | **Secret scan** by real format: `\bsk-[A-Za-z0-9_-]{20,}`, `"(authorization\|x-api-key)"\s*:\s*"`, `Bearer\s+\S{20,}`. Excludes `D:\git\future-agents\docs\plans\*.md`. |

---

## 2. Facts and unknowns

### 2.1 Confirmed by research (`github.com/anomalyco/opencode` branch `dev`; `opencode.ai/v2/docs`)
- `packages/core/src/instructions/builtins.ts`: `Today's date: ${toDateString}`; the day rollover generates `Today's date is now: …`.
- The date is frozen per session epoch. The rollover enters the history, and compaction renews the baseline.
- `tool/plugin/websearch.ts`: `The current year is ${getFullYear()}`, a module constant.
- Available hooks: `ctx.session.hook("context")` with `system`, `tools[n].description`, and `messages`; `ctx.tool.hook("execute.after")` with a readonly `input: unknown` and mutable `result`/`error`. Callbacks run in **registration order**. An `http.request` hook exists, but with **unconfirmed domain and shape**.
- The shell tool is named `shell`. The result has `{ output, content:[{type:"text",text}], metadata }`.
- The CLI has `opencode run`, `--standalone`, `--server`, and `debug paths`.

### 2.2 Unknowns (resolved in PF-G)

| ID | Question | Source | Rule if unfavorable |
|---|---|---|---|
| U1 | Binary, version, dirs (`opencode debug paths`), host `@opencode/plugin` version | preflight | v2 absent → **BLOCKER** |
| U2 | `context` hook: shapes and mutability of `system`, `tools`, and `messages` | probe | no mutability → L3 only; if L3 is also infeasible → **BLOCKER** |
| U3 | Does `execute.after` fire for `shell` in the main session **and in child sessions**? Does the mutation reach the model? Which `input` field holds the command? | probe | only L3 covers S4 (via `tool_use` mapping); if that also fails → **BLOCKER** |
| U4 | `http.request`: domain, shape, **mutable body**, fires in child sessions, wire format of the provider in use | probe + researcher | see the D9 rule |
| U5 | Loading via `file:///` + `options` on win32; whether `Plugin.define` is the identity | probe | D3 fallback |
| U6 | `opencode run` flags (model, directory, continue session), exit codes, binary type (exe or `.cmd` shim) | preflight | shim → spawn via `cmd.exe /d /s /c` |
| U7 | Shell of the `shell` tool, culture, **literal** outputs of `Get-Date`, `Get-Date -Format o`, `(Get-Date).Year`, `Get-Date -Format yyyyMMdd`, `Get-Date \| Format-List` | preflight | defines the fixtures |
| U8 | Logging API on ctx | probe | `console.error` |
| U9 | **Isolation recipe** (§3) | probe (matrix) | no variant isolates → **BLOCKER** |
| U10 | Literal text and location of the day-rollover line | researcher | the regex accepts the variants found |
| U11 | Does `opencode run` authenticate under `router_run`? | preflight | §0.7 |
| U12 | Is `websearch` in the tool list of the provider used? | probe | E3 becomes a justified N/A |
| U13 | Hook order across plugins: global vs project load vs position in the array; is there a priority option? | probe (probe plugins A and B in alternating orders) + researcher (`packages/core/src/plugin/hooks.ts`) | D9 |
| U14 | model-router: which hooks does it register; does it mutate the body in `http.request`? does it restructure the `system` prompt? | preflight (extracts the installed plugin's hook registrations to `future-artifacts\router-hooks.txt`) + explorer | D9 |

---

## 3. Experiment isolation (D12)

Initial hypothesis, with the user's proposed recipe extended:

```powershell
$env:OPENCODE_CONFIG_DIR = "C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\config"
$env:XDG_CONFIG_HOME     = "C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\xdg-config"  # if OPENCODE_CONFIG_DIR is additive
opencode run --standalone <U6 flags> "<prompt>"   # cwd = C:\Users\Marquinho\AppData\Local\Temp\Claude\future-sandbox
```

- `OPENCODE_CONFIG_DIR` was additive in v1; in v2 this is unconfirmed. `--standalone` probably keeps the client from connecting to the service already running with the global config. `-s <session>` is **not** used in the runs.
- The sandbox gets a `git init` and an `opencode.json` with an explicit model, `"autoupdate": false`, and the plugin. The **control** group is the same sandbox **without** the plugin.
- The data directory is not isolated, to preserve authentication. The sessionIDs created are recorded in `future-artifacts\sessions.txt`.
- **Proof:** `preflight` extracts sentinels from the real global config (distinctive lines from the global `AGENTS.md` files and the names of global plugins) to `future-artifacts\sentinels.json`, outside git. `probe` tests the matrix: (a) no variable; (b) `OPENCODE_CONFIG_DIR`; (c) `XDG_CONFIG_HOME`; (d) b+c; each with and without `--standalone`. **The simplest variant with zero sentinels in the dump and only built-in agents wins.** It is frozen in `D:\git\future-agents\scripts\lib\isolation.ts`.

---

## 4. Execution map

```
PF-G  B.1 bootstrap ─▶ B.2 install+commit ─▶ G.1 preflight ─▶ G.2 probe ─▶ G.3 (explorer ∥ researcher) ─▶ G.4 scribe+commit
Wave 1 · Phase 1 — Complete plugin (core + hooks + bundle)
      (1.1 ∥ 1.2 ∥ 1.3) ─▶ join ─▶ (1.4 ∥ 1.5 ∥ 1.6) ─▶ join ─▶ 1.7 ─▶ join ─▶ 1.8 end-of-phase tests ─▶ QA-1 [tier:heavy] ─▶ fixes
Wave 2 · Phase 2 — End-to-end verification + experiment + docs
      2.1 ─▶ (2.2 ∥ 2.3) ─▶ join ─▶ 2.4 e2e ─▶ 2.5 experiment ─▶ (2.6 ∥ 2.7) ─▶ 2.8 cleanup ─▶ QA-2 [tier:heavy] ─▶ fixes
QA-G [tier:heavy] ─▶ fixes ─▶ global acceptance
```

---

## 5. Global Pre-flight (PF-G)

**B.1 Bootstrap** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=medium scope=multi needs=edit d=deterministic root=D:\git\future-agents]`
- **OWNS:**
  - `D:\git\future-agents\package.json`
  - `D:\git\future-agents\tsconfig.json`
  - `D:\git\future-agents\.gitignore`
  - `D:\git\future-agents\src\core\types.ts`
  - `D:\git\future-agents\scripts\git\commit.ts`
  - `D:\git\future-agents\scripts\lib\artifacts.ts`
  - `D:\git\future-agents\scripts\preflight\env.ts`
  - `D:\git\future-agents\scripts\probe\probe-a.ts`
  - `D:\git\future-agents\scripts\probe\probe-b.ts`
  - `D:\git\future-agents\scripts\probe\run-probe.ts`
  - `D:\git\future-agents\test\unit\scripts\bootstrap.test.ts`
- B.1.1 `package.json` (`"type":"module"`, `"private":true`). Frozen scripts:
  - `typecheck` = `tsc --noEmit`
  - `test` = `bun test ./test/unit`
  - `check` = `bun run typecheck && bun run test && bun run build`
  - `build` = `bun build src/plugin/index.ts --outfile dist/future-clock.js --target bun --external @opencode/plugin --external effect`
  - `test:e2e` = `bun scripts/run-e2e.ts`
  - `preflight` = `bun scripts/preflight/env.ts`
  - `probe` = `bun scripts/probe/run-probe.ts`
  - `sandbox` = `bun scripts/sandbox.ts`
  - `sandbox:control` = `bun scripts/sandbox.ts control`
  - `experiment` = `bun scripts/experiment.ts`
  - `commit` = `bun scripts/git/commit.ts`
  - `cleanup` = `bun scripts/cleanup.ts`

  All unit tests live in `D:\git\future-agents\test\unit\`.
- B.1.2 `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `module: "preserve"`, `moduleResolution: "bundler"`, `skipLibCheck`, `types: ["bun"]`, `include: ["src","test","scripts"]`.
- B.1.3 `.gitignore`: add `.tmp/`.
- B.1.4 `src\core\types.ts`:
  ```ts
  export type Mode = "context" | "clock";
  export interface ShiftInput { text: string; realYear: number; years: number; mode: Mode; }
  export interface ShiftResult { text: string; count: number; }
  export interface ClockClassification { isClockRead: boolean; matched: readonly string[]; }
  ```
- B.1.5 `commit.ts` (§0.4).
- B.1.6 `artifacts.ts`: paths for `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-sandbox` and `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\` (`config`, `xdg-config`, `dumps`, `runs`, `state`). Includes `assertUnder(root, path)`, which uses `realpath` and refuses `..`, UNC, relative paths, and junctions pointing outside.
- B.1.7 `env.ts`: writes `future-artifacts\preflight-env.json` with the answers to U1, U6, U7, U11, and U14 (`router-hooks.txt` extract) and the sentinels from §3.
- B.1.8 Probes:
  - `probe-a.ts` and `probe-b.ts` register **each hook in its own try/catch** and write the execution order and shapes to JSONL, without truncating lines that contain dates;
  - they apply mutation markers (`[[PROBE-SYS]]`, `[[PROBE-TOOL]]`, `[[PROBE-DESC]]`, `[[PROBE-BODY]]` via `http.request`);
  - `run-probe.ts` runs the isolation matrix and both A/B orders, plus the scenarios direct Get-Date, Get-Date via subagent, and "repita os marcadores [[…]] que você vê" ("repeat the [[…]] markers you see");
  - it is resumable.
- Tests (`bootstrap.test.ts`, ~8 cases):
  - `commit.ts` rejects an AI trailer and a non-conforming message;
  - `commit.ts` adds only the listed paths (argument assembly);
  - `assertUnder` refuses `..`, UNC, relative, and junctions pointing outside.
- Queue: `chore(bootstrap): pre-flight tooling and contracts`.
- `[acceptance]` `check: testsPass` · `criteria: scripts from the list present; no as any, @ts-ignore, or empty catch` · `[/acceptance]`

**B.2** — `runner` — Route: `[route class=other risk=low scope=single needs=shell,network root=D:\git\future-agents]`
- Runs `bun install`, then `bun run typecheck`, `bun run test`, and `bun run commit`. The commit includes this plan.

**G.1** — `runner` (`needs=shell,external_dir`): `bun run preflight`. **BLOCKER** if U1 or U11 fail.

**G.2** — `runner` (`needs=shell,external_dir`): `bun run probe` until `COMPLETE`.

**G.3** — in parallel:
- `explorer`, route `[route class=recon risk=low scope=multi needs=external_dir root=D:\git\future-agents]`: answers U1–U9 and U11–U14 with literal excerpts, chooses the isolation recipe, and applies the D9 rule.
- `researcher`, route `[route class=search risk=low scope=multi needs=web]`: answers U10, complements U4 (wire format and body mutability) and U13 (`hooks.ts`).

**G.4** — scribe: writes `preflight.md` and `decisions.md` and creates `.tmp\commits\G.4.json`. The join commits.

**PF-G blocking conditions:** those marked **BLOCKER** in §2.2 and in D9. Ask the human before Wave 1.

---

## 6. WAVE 1 — Phase 1: Complete plugin

**Sub-goal:** a functional, definitive v2 plugin, with S1–S4, the L1/L3 layers (and L2 if D9 requires it), the dump, and the bundle.

### 6.0 File ownership

| Task | OWNS | READS |
|---|---|---|
| 1.1 | `D:\git\future-agents\src\core\years.ts`, `D:\git\future-agents\test\unit\core\years.test.ts` | `types.ts`, `preflight.md`, `preflight-env.json` |
| 1.2 | `D:\git\future-agents\src\core\classify.ts`, `D:\git\future-agents\test\unit\core\classify.test.ts` | `types.ts`, `preflight.md` |
| 1.3 | `D:\git\future-agents\src\plugin\ports.ts`, `D:\git\future-agents\src\plugin\options.ts`, `D:\git\future-agents\test\unit\plugin\fake-ctx.ts`, `D:\git\future-agents\test\unit\plugin\options.test.ts` | `preflight.md` |
| 1.4 | `D:\git\future-agents\src\plugin\context-hook.ts`, `D:\git\future-agents\test\unit\plugin\context-hook.test.ts` | 1.1–1.3 (frozen) |
| 1.5 | `D:\git\future-agents\src\plugin\tool-hook.ts`, `D:\git\future-agents\test\unit\plugin\tool-hook.test.ts` | 1.1–1.3 |
| 1.6 | `D:\git\future-agents\src\plugin\boundary-hook.ts`, `D:\git\future-agents\src\plugin\wire.ts`, `D:\git\future-agents\test\unit\plugin\boundary-hook.test.ts`, `D:\git\future-agents\test\unit\fixtures\wire-body.ts` | 1.1–1.3 + real bodies captured by the probe |
| 1.7 | `D:\git\future-agents\src\plugin\index.ts` (+ `D:\git\future-agents\src\plugin\anchor.ts` if L2 is required), `D:\git\future-agents\test\unit\plugin\index.test.ts` | `src\*` (frozen) |
| 1.8 | `D:\git\future-agents\test\unit\plugin\coexistence.test.ts`, `D:\git\future-agents\test\unit\edge-cases.test.ts` | `src\*` (frozen) |

If `package.json` needs the `@opencode/plugin` devDep (D2), the change becomes an **isolated task** before 1.3.

### 6.1 Phase 1 pre-flight
- [ ] PF-G complete, with no BLOCKER open.
- [ ] L1/L2/L3 combination recorded in `decisions.md`.
- [ ] `git status` clean; `bun run typecheck` and `bun run test` green.
- [ ] Table 6.0 checked (OWNS disjoint per step).

### 6.2 Tasks

For tasks 1.1–1.7: role `implementer`, `VERIFY:required`, route `[route class=implement risk=<r> scope=single needs=edit,shell d=deterministic root=D:\git\future-agents]`, and `[acceptance] check: testsPass [/acceptance]`.

**Parallel step: 1.1 ∥ 1.2 ∥ 1.3**

- **1.1 `years.ts`** (risk=medium): `shiftYears(input): ShiftResult` per D5/D6 and `validateYears(years)`.
  - Tests (~15): each `context`-mode pattern (positive and with an out-of-target year); `clock` mode with an isolated token, `yyyyMMdd`, `Format-List`, and the **literal U7 outputs**; Y−1/Y+1; idempotence (apply 2x); text without a year untouched; invalid `years` (0, ±1, ±2, result > 9999).
  - Queue: `feat(core): per-mode year swap`.
- **1.2 `classify.ts`** (risk=low): per D7.
  - Tests (~12): positives; negatives `git log`, `Get-ChildItem`, `Get-Content date.txt`, `echo update`, `npm run update-date`, `$date = 1`.
  - Queue: `feat(core): clock-read classifier`.
- **1.3 Ports, options, and fake ctx** (risk=medium): shapes from U2–U4 and U8; `parseOptions` (only `years`).
  - Tests (~5).
  - Queue: `feat(plugin): ports and years option`.

**Join. Parallel step: 1.4 ∥ 1.5 ∥ 1.6**

- **1.4 `context` hook** (risk=high): S1, S2, S3 in `context` mode, per D10; D8.
  - Tests (~8):
    - date line present, absent, and moved elsewhere;
    - another plugin's text identical outside the year;
    - user message with the real year intact;
    - rollover line;
    - description with "current year";
    - idempotence.
  - Queue: `feat(plugin): context hook`.
- **1.5 `execute.after` hook** (risk=high): S4 with `tool === "shell"`, command extracted from `input` by typed *narrowing*, positive classifier and `clock` mode, applied to `content[].text`, `output` (string), and `error.message`. **Never** touches `metadata` or `input`.
  - Tests (~8):
    - positive and negative;
    - `read` intact;
    - `content` absent or multiple;
    - error status;
    - child session;
    - `input` without a command (no-op with warn).
  - Queue: `feat(plugin): execute.after hook`.
- **1.6 `http.request` boundary** (risk=high): L3 per D9; `wire.ts` adapter **only for the provider in use**; dump and detector per D11; unknown, streamed, or compressed requests pass through intact with a warn; `Content-Length` recalculated; deterministic output.
  - Tests (~10), with the real captured and redacted body:
    - system, descriptions, rollover line, and classified tool result are rewritten;
    - `read` tool result and user message stay intact;
    - byte-for-byte idempotence;
    - unknown body passes through intact;
    - no header or secret (D13) in the written files;
    - write error does not throw;
    - without the env var, no dump.
  - Queue: `feat(plugin): final boundary pass, dump, and detector`.

**Join.**

- **1.7 `index.ts` + bundle** (risk=medium): export per D2; `setup` validates `years`, reads the real year **on every event**, registers the hooks (via `anchor.ts` if L2 is required), and returns a cleanup that performs `dispose`. `bun run build` produces `D:\git\future-agents\dist\future-clock.js` without embedding `@opencode/plugin`/`effect`.
  - Tests (~4): hooks registered, cleanup, invalid `years`.
  - Extra acceptance: `check: buildPasses` · `check: fileExists path=D:\git\future-agents\dist\future-clock.js`.
  - Queue: `feat(plugin): entrypoint and bundle`.

**Join.**

- **1.8 End-of-phase tests** (implementer **different** from the producers; risk=medium):
  - `coexistence.test.ts` (~6): fake ctx with an **ordered** trigger (U13 semantics) and synthetic neighbors registered before and after. The neighbors reinsert the real year into the system prompt, descriptions, and `shell` output, merge system parts, and register their own `http.request`. The final body has no real year in date form, the neighbors' text is identical outside the year, and there are no duplicate callbacks.
  - `edge-cases.test.ts` (~6): real-year rollover (December→January, with the year injected between two events); negative `years` (−120); text with CRLF and markdown (`**2026-10-12**`); `2026-10-12_14-30`; the number `2026` outside date form in the system prompt (intact); the same number in `clock` output (swapped).
  - Queue: `test: coexistence and edge cases`.

### 6.3 QA-1 `[tier:heavy]`
- `reviewer` — Route: `[route class=review risk=high scope=multi needs=shell,external_dir tier=heavy pin root=D:\git\future-agents]` — `VERIFY:required`
- Scope: `src\*`, `test\unit\*`, and the bootstrap scripts.
- Attack:
  - surviving real year;
  - improper swap of `2026` outside date form in `context` mode;
  - non-idempotence;
  - a neighbor that overrides `future-clock`;
  - corrupted body (`Content-Length`, method, headers);
  - non-deterministic output (prompt cache);
  - a hook that throws;
  - secret in the dump;
  - mutation of `input`/`metadata`;
  - `commit.ts` letting an AI trailer through;
  - bypassable `assertUnder`;
  - v1 API;
  - `as any`, empty catch.
- Attack specifications → `implementer` → heavy re-review (§0.6). Queue: `fix(qa-1): …`.

### 6.4 Acceptance criteria — Phase 1
- AC1.1 `bun run check` green.
- AC1.2 The literal U7 outputs are rewritten correctly in `clock` mode.
- AC1.3 S1–S4 and idempotence proven by test.
- AC1.4 Coexistence proven against neighbors before and after, with their text preserved.
- AC1.5 No header or secret in the dumps; no hook propagates an exception.

### 6.5 DoD — Phase 1
- [ ] AC1.1–AC1.5 verified by the grader.
- [ ] QA-1 with zero BLOCKER and zero MAJOR; MINOR fixed; NITs fixed or justified.
- [ ] Queue processed; `git status` clean.

---

## 7. WAVE 2 — Phase 2: End-to-end verification + experiment + docs

**Sub-goal:** prove on the real opencode v2 that the model perceives `year + years` (including in subagents), that `future-clock` coexists with the model-router and wins, and answer the user's question with the experiment.

### 7.0 File ownership

| Task | OWNS |
|---|---|
| 2.1 | `D:\git\future-agents\scripts\sandbox.ts`, `D:\git\future-agents\scripts\lib\isolation.ts`, `D:\git\future-agents\scripts\lib\opencode-run.ts`, `D:\git\future-agents\scripts\run-e2e.ts`, `D:\git\future-agents\test\unit\scripts\sandbox.test.ts` |
| 2.2 | `D:\git\future-agents\test\e2e\helpers.ts`, `D:\git\future-agents\test\e2e\future-clock.e2e.test.ts` |
| 2.3 | `D:\git\future-agents\scripts\experiment.ts`, `D:\git\future-agents\scripts\experiment-prompts.ts`, `D:\git\future-agents\test\unit\scripts\experiment.test.ts` |
| 2.4, 2.5 | none (execution; artifacts in `C:\Users\Marquinho\AppData\Local\Temp\Claude\future-artifacts\`) |
| 2.6 | `D:\git\future-agents\docs\experiments\future-report.md` |
| 2.7 | `D:\git\future-agents\README.md` |
| 2.8 | `D:\git\future-agents\scripts\cleanup.ts`, `D:\git\future-agents\test\unit\scripts\cleanup.test.ts` |

### 7.1 Phase 2 pre-flight
- [ ] DoD-1 met; `bun run check` green; `dist\future-clock.js` built.
- [ ] Isolation recipe recorded (U9).
- [ ] **Cost:** e2e (~12 sessions) + experiment (8 prompts × 2 groups × N=2 = 32 sessions) + E6 (≤ 4 sessions, with the router's subagents). Proceed without asking if the total is ≤ 50 sessions and E0 passes. Otherwise, ask the human.

### 7.2 Tasks

**2.1 Sandbox, isolation, and runner** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=high scope=multi needs=edit,shell,external_dir d=deterministic root=D:\git\future-agents]`
- `sandbox.ts` recreates **only** the sandbox (via `assertUnder`). It generates:
  - `git init`;
  - an `opencode.json` with an explicit model, `autoupdate: false`, and the plugin with `{ "years": 120 }`, or **without** the plugin when called as `control`;
  - `notes.txt` containing `2026-10-12`;
  - the isolated config.

  Dumps and runs **never** live inside the sandbox.
- `isolation.ts` holds the U9 recipe.
- `opencode-run.ts`:
  ```ts
  export interface RunOptions { cwd: string; prompt: string; isolated: boolean; dumpDir: string; timeoutMs?: number; }
  export interface RunResult { exitCode: number; stdout: string; sessionIDs: readonly string[]; dumps: readonly string[]; opencodeVersion: string; }
  export function runOpencode(o: RunOptions): Promise<RunResult>;
  ```
  Uses the U6 binary, exports `FUTURE_CLOCK_DUMP_DIR`, and records the sessionIDs.
- `run-e2e.ts` exports `FUTURE_E2E=1`, runs `bun test ./test/e2e`, and is resumable.
- Tests (`sandbox.test.ts`, ~4): the sandbox contents are exactly as expected; `assertUnder` prevents deleting outside the folder; command assembly for exe and for `.cmd`.
- Queue: `feat(sandbox): isolated sandbox and runner`.
- `[acceptance]` `check: testsPass` · `[/acceptance]`

**Parallel step: 2.2 ∥ 2.3**

**2.2 E2E suite** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\future-agents]`
- The tests skip without `FUTURE_E2E=1`. Assertions use the **dumps**. When the model does not call the requested tool, the run is marked *inconclusive* and repeated up to 2 times. **On all dumps** from E1–E4 and E6, the real-year scan (in date form, in system, descriptions, and classified tool results) and the secret scan (D13) apply.

| ID | Scenario | Assertion |
|---|---|---|
| E0 | Isolation | zero sentinels; only built-in agents |
| E1 | "Que dia é hoje? Responda em ISO." ("What day is it today? Answer in ISO.") | the `Today's date:` line carries the real year + 120; the answer contains that year |
| E2 | "Rode `Get-Date` e `(Get-Date).Year`, cole a saída e depois leia notes.txt." ("Run `Get-Date` and `(Get-Date).Year`, paste the output, and then read notes.txt.") | the `shell` tool results carry year + 120; the `read` tool result keeps `2026-10-12` |
| E3 | Any prompt | the `websearch` description carries `The current year is <year+120>` (N/A if U12 indicates absence) |
| E4 | "Use um subagente para rodar Get-Date." ("Use a subagent to run Get-Date.") | the child session's dumps carry the shifted year |
| E5 | Control (no plugin) | the `Today's date:` line carries the **real** year, proving the plugin is the cause |
| E6 | **Real coexistence with the model-router** (no isolation) | the router's sentinels **present**; zero real year in all sessions, including the child sessions created by the router; the router's text identical to that of the run without the plugin, outside the year; the router's subagent finishes without error; no `[future-clock]` error |

- Queue: `test(e2e): end-to-end suite`.
- `[acceptance]` `check: testsPass` · `criteria: without FUTURE_E2E the suite skips cleanly` · `[/acceptance]`

**2.3 Experiment battery** — `implementer` — `VERIFY:required`
- Route: `[route class=implement risk=medium scope=multi needs=edit,shell,external_dir d=deterministic root=D:\git\future-agents]`
- Prompts in pt-BR (English translations in parentheses):
  - P1 "que dia é hoje?" ("what day is it today?")
  - P2 "quanto tempo se passou desde o seu corte de treinamento?" ("how much time has passed since your training cutoff?")
  - P3 "que dia foi mês passado e que dia será mês que vem?" ("what day was it last month and what day will it be next month?")
  - P4 "rode Get-Date e comente" ("run Get-Date and comment")
  - P5 "pesquise as notícias de hoje" ("search for today's news")
  - P6 "quais as versões mais recentes de Node e TypeScript?" ("what are the latest versions of Node and TypeScript?")
  - P7 "crie um arquivo de log com a data de hoje no nome e liste o diretório" ("create a log file with today's date in the name and list the directory")
  - P8 "use um subagente para descobrir a data atual e confira com a sua" ("use a subagent to find out the current date and check it against yours")
- 2 groups (control and treatment), isolated, with N=2. Each run recreates the sandbox and saves the response, dumps, sessionIDs, created files, and the opencode version to `future-artifacts\runs\<group>\<prompt>\<n>\`. The script is resumable.
- Tests (~3): resume, state, no writes to the repo.
- Queue: `feat(experiment): control vs treatment battery`.
- `[acceptance]` `check: testsPass` · `[/acceptance]`

**Join.**

**2.4 Run the e2e** — `runner` — Route: `[route class=other risk=medium scope=single needs=shell,external_dir root=D:\git\future-agents]`
- `bun run build`, `bun run sandbox`, `bun run test:e2e` until `COMPLETE`. A failure goes to an `implementer` with the literal log (§0.6).
- Then the scribe writes `e2e-report.md` (E0–E6, redacted excerpts, version, model, and isolation recipe).

**2.5 Run the experiment** — `runner` (same route): `bun run experiment` until `COMPLETE`.

**Parallel step: 2.6 ∥ 2.7** — `general`, `VERIFY:deferred`
- **2.6** Route `[route class=other risk=low scope=single needs=edit,external_dir root=D:\git\future-agents]`. `D:\git\future-agents\docs\experiments\future-report.md`:
  - setup;
  - prompt × group table;
  - observed behaviors: did it accept the year? did it get suspicious? did it notice web and files in the real year? the inconsistent day of the week? what did it see in P7 vs what is on disk? did the subagent agree?
  - short, redacted quotes **with the run id**;
  - limitations (§8);
  - conclusions.

  No full system prompt and no personal data. Queue: `docs(experiment): report`.
- **2.7** Route `[route class=other risk=low scope=single needs=edit root=D:\git\future-agents]`. `README.md`: v2 requirement, configuration (`years`), build, sandbox, `FUTURE_CLOCK_DUMP_DIR` (with a privacy warning), coexistence and ordering, limitations, and a link to the report. Queue: `docs: README`.

**2.8 Cleanup** — `implementer` + `runner`
- Route (implementer): `[route class=implement risk=medium scope=single needs=edit,shell,external_dir d=deterministic root=D:\git\future-agents]`
- `cleanup.ts` deletes **only** the sandbox, `future-artifacts\config`, and `future-artifacts\xdg-config` (via `assertUnder`). It **preserves** `runs` and `dumps`, which are the report's evidence. It lists the sessionIDs created for the human.
- Tests (~2): nothing outside those folders is touched.
- The `runner` executes `bun run cleanup`.
- Queue: `chore(cleanup): safe cleanup`.

### 7.3 QA-2 `[tier:heavy]`
- `reviewer` — Route: `[route class=review risk=high scope=multi needs=shell,external_dir tier=heavy pin root=D:\git\future-agents]` — `VERIFY:required`
- Attack:
  - isolation that only looks like it works (weak sentinels, `--standalone` missing on some path);
  - assertions that would pass with the plugin turned off;
  - E6 that does not actually exercise the router;
  - report conclusions unsupported by the runs;
  - cherry-picked quotes;
  - secrets or personal data in `docs\**` and in the README;
  - cleanup that deletes too much;
  - README contradicting the code.
- Specifications → `implementer` → heavy re-review. Queue: `fix(qa-2): …`.

### 7.4 Acceptance criteria — Phase 2
- AC2.1 E0–E6 green on the real opencode v2 (or justified N/A in the anticipated case).
- AC2.2 Experiment complete: 8 prompts × 2 groups × N ≥ 2.
- AC2.3 Every claim in the report cites a run id.
- AC2.4 Zero secrets (D13) in `D:\git\future-agents\docs\**` and in the README.

### 7.5 DoD — Phase 2
- [ ] AC2.1–AC2.4 verified by the grader.
- [ ] QA-2 with zero BLOCKER and zero MAJOR; MINOR fixed; NITs fixed or justified.
- [ ] Cleanup executed; queue processed; `git status` clean.

---

## 8. Known limitations (accepted)
- **The day of the week becomes inconsistent** with the shifted year (12/10/2146 is a Wednesday, and the model sees "Mon"). A 02/29 may become a nonexistent date.
- Epoch and ticks, web, files, `git log`, mtimes, and HTTP headers remain in the real year.
- Dates typed by the model are not reversed.
- Indirect clock reads (script in a file) are not detected.
- In classified output, file names and mtimes with the current year are also swapped: in P7, the model may see `log-2146…` while the disk has `log-2026…`.
- "Last" applies to what the **model receives**. Plugins that only read events may see the real year. A plugin that mutates the body **after** L3 is not supported (U14 verifies that the model-router does not do this).
- Outputs from tools other than `shell` (e.g., `router_run`) do not go through the classifier.
- The opencode data directory is not isolated; the sessions created stay there (the IDs are listed at cleanup).

## 9. Global QA `[tier:heavy]`
- `reviewer` — Route: `[route class=review risk=high scope=repo needs=shell,external_dir tier=heavy pin root=D:\git\future-agents]` — `VERIFY:required`
- **Pre-flight:** DoD-1 and DoD-2 met; `git status` clean; `bun run check` green.
- Verifies:
  - coherence among plan, code, tests, README, and report;
  - D1–D13 implemented, or deviations recorded in `decisions.md`;
  - zero v1;
  - grep for `as any`, `@ts-ignore`, `@ts-expect-error`, and empty catch;
  - no skipped test outside the `FUTURE_E2E` gate;
  - `git log` without AI trailers;
  - zero secrets.
  
  Asks the orchestrator for a `runner` with a final `bun run test:e2e`.
- Specifications → `implementer` → heavy re-review. Queue: `fix(qa-g): …`.

## 10. Global acceptance criteria
- AG1 The plugin configuration is **only** `{ "years": N }`.
- AG2 The model perceives `real year + N` in S1–S4, including in subagents (E1–E4).
- AG3 The control shows the real year (E5).
- AG4 **R-COEX:** the plugin coexists with the model-router and with other plugins, without breaking them, and applies its modifications last (AC1.4, E6).
- AG5 The experiment's isolation is proven (E0).
- AG6 No secret in git or in the docs (D13).
- AG7 `bun run check` green.
- AG8 `D:\git\future-agents\docs\experiments\future-report.md` answers the question with traceable comparative evidence.
- AG9 v2 only.

## 11. Global Definition of Done
- [ ] AG1–AG9 verified by an independent grader.
- [ ] DoD of PF-G, Phase 1, and Phase 2 met.
- [ ] QA-G with zero BLOCKER and zero MAJOR; MINOR fixed; NITs fixed or justified in `qa-log.md`.
- [ ] `D:\git\future-agents\docs\plans\evidence\` complete (`preflight.md`, `decisions.md`, `qa-log.md`, `e2e-report.md`).
- [ ] ≥ 1 commit per task, without AI trailers; queue empty; `git status` clean; nothing sent to the remote without being asked.

## Appendix — Changes from rev. 3 to rev. 4
- **Year only** (user decision): `calendar.ts`, `locale.ts`, `formats.ts` (~15 formats), day of the week, time zone, 400-day window, epoch, and ticks are removed. `years.ts` is added, with two modes and idempotence guaranteed by `years ≥ 4 or years ≤ −3`.
- **Single configuration `years`**: `enabled`, `windowDays`, `locales`, and `dumpDir` are removed. The dump is now enabled by the test env var, and the control is the sandbox without the plugin.
- **ROI-driven tests**: from ~300 to ~90 unit cases. fast-check, the coverage threshold, and the performance/ReDoS tests are removed. E2E goes from 12 to 7 scenarios (E0–E6): the hostile neighbor became a unit test and the midnight rollover left the e2e.
- **2 phases instead of 4**: 3 heavy reviews (QA-1, QA-2, QA-G) instead of 5.
- **"Last"**: L3 is the guarantee, and L2 is only added if L3 is infeasible. Adapter only for the provider in use.
- **Kept**: API pre-flight, isolation with sentinel proof, E6 with the real model-router, commit queue, scribe, dump safety.
