// Resumable runner for the opencode v2 runtime probe matrix (plan §2.2, §3, B.1.8).
// Each invocation runs at most MAX_RUNS_PER_INVOCATION opencode runs, then prints progress.
// Usage: bun run probe [--reset]
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACTS,
  ISOLATION_XDG_CONFIG,
  PROBE_ROOT,
  artifactPath,
  assertUnder,
  ensureIsolationDirs,
  isolationEnv,
} from "../lib/artifacts";

const MAX_RUNS_PER_INVOCATION = 8;
const RUN_TIMEOUT_MS = 240_000;
const MAX_CAPTURE = 1_000_000;
const SUMMARY_LIMIT = 4096;
const MAX_STDERR = 200_000;
const MAX_PLUGIN_LOG_LINES = 200;
const PLUGIN_LOG_RE = /plugin|probe|error|warn/i;

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PROBE_OUT_ROOT = artifactPath("probe");
const DIST_DIR = join(PROBE_OUT_ROOT, "dist");
const STATE_FILE = artifactPath("state", "probe.json");
const MODEL = process.env["PROBE_MODEL"] ?? "opencode-go/claude-haiku-5-5";

type ProbeId = "A" | "B";
type Variant = "none" | "xdg";
type Where = "project" | "global";

interface PluginSpec {
  id: ProbeId;
  where: Where;
  mutate: boolean;
  reanchor: boolean;
}

interface Scenario {
  name: string;
  variant: Variant | "real";
  standalone: boolean;
  plugins: PluginSpec[];
  prompt: string;
}

interface ScenarioResult {
  name: string;
  finishedAt: string;
  model: string;
  exitCode: number | null;
  timedOut: boolean;
  modelNotFound: boolean;
  eventLines: number;
  sentinelHits: string[];
  pluginsListed: unknown;
}

interface State {
  model: string;
  done: Record<string, ScenarioResult>;
}

const PROMPT_OK = "Responda apenas: OK";
const PROMPT_DATE = "Rode Get-Date no shell e responda OK";
const PROMPT_MUTATE =
  "Rode Get-Date no shell. Depois repita literalmente TODOS os textos entre [[ e ]] que você encontrar no seu system prompt, nas descrições das ferramentas e na saída da ferramenta, e diga onde encontrou cada um.";
const PROMPT_CHILD =
  "Use um subagente (ferramenta de subagente/task) para rodar Get-Date no shell e me diga a saída exata que ele obteve.";

function plain(id: ProbeId, where: Where = "project"): PluginSpec {
  return { id, where, mutate: false, reanchor: false };
}

function buildScenarios(): Scenario[] {
  const list: Scenario[] = [];
  const variants: Variant[] = ["none", "xdg"];
  for (const variant of variants) {
    for (const standalone of [true, false]) {
      list.push({
        name: `S-iso-${variant}-${standalone ? "standalone" : "service"}`,
        variant,
        standalone,
        plugins: [plain("A")],
        prompt: PROMPT_OK,
      });
    }
  }
  list.push({ name: "S-order-AB", variant: "xdg", standalone: true, plugins: [plain("A"), plain("B")], prompt: PROMPT_DATE });
  list.push({ name: "S-order-BA", variant: "xdg", standalone: true, plugins: [plain("B"), plain("A")], prompt: PROMPT_DATE });
  list.push({
    name: "S-order-globalB",
    variant: "xdg",
    standalone: true,
    plugins: [plain("A"), plain("B", "global")],
    prompt: PROMPT_DATE,
  });
  list.push({
    name: "S-reanchor",
    variant: "xdg",
    standalone: true,
    plugins: [{ id: "A", where: "project", mutate: false, reanchor: true }, plain("B")],
    prompt: "Rode Get-Date no shell duas vezes, em chamadas separadas, e responda OK",
  });
  list.push({
    name: "S-mutate",
    variant: "xdg",
    standalone: true,
    plugins: [{ id: "A", where: "project", mutate: true, reanchor: false }],
    prompt: PROMPT_MUTATE,
  });
  list.push({
    name: "S-child",
    variant: "xdg",
    standalone: true,
    plugins: [{ id: "A", where: "project", mutate: true, reanchor: false }],
    prompt: PROMPT_CHILD,
  });
  list.push({ name: "S-real", variant: "real", standalone: true, plugins: [plain("A")], prompt: PROMPT_OK });
  return list;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function probeDir(id: string): string {
  return join(DIST_DIR, `probe-${id}`);
}

async function spawnWait(argv: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
}

async function buildProbes(): Promise<void> {
  await mkdir(DIST_DIR, { recursive: true });
  for (const id of ["a", "b"]) {
    const pkgDir = probeDir(id);
    await mkdir(pkgDir, { recursive: true });
    const outfile = join(pkgDir, "server.js");
    const { exitCode, stderr } = await spawnWait(
      [
        process.execPath,
        "build",
        `scripts/probe/probe-${id}.ts`,
        "--outfile",
        outfile,
        "--target",
        "bun",
        "--external",
        "@opencode/plugin",
        "--external",
        "effect",
      ],
      REPO_ROOT,
    );
    if (exitCode !== 0) throw new Error(`bun build probe-${id} failed (${exitCode}): ${stderr.slice(0, 1000)}`);
    const pkg = {
      name: `probe-${id}`,
      version: "0.0.0",
      type: "module",
      main: "./server.js",
      exports: { ".": "./server.js", "./server": "./server.js" },
    };
    await writeFile(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2));
  }
}

async function freshDir(root: string, dir: string): Promise<void> {
  const safe = await assertUnder(root, dir);
  await rm(safe, { recursive: true, force: true });
  await mkdir(safe, { recursive: true });
}

function pluginEntry(spec: PluginSpec, logPath: string, bodyDir: string): Record<string, unknown> {
  return {
    package: probeDir(spec.id.toLowerCase()),
    options: { log: logPath, mutate: spec.mutate, reanchor: spec.reanchor, bodyDir },
  };
}

function baseConfig(plugins: Record<string, unknown>[]): Record<string, unknown> {
  return { $schema: "https://opencode.ai/config.json", autoupdate: false, model: MODEL, plugins };
}

async function readState(): Promise<State> {
  try {
    const parsed: unknown = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (isRecord(parsed) && isRecord(parsed["done"])) {
      const done: Record<string, ScenarioResult> = {};
      for (const [k, v] of Object.entries(parsed["done"])) {
        if (isRecord(v) && typeof v["name"] === "string") {
          done[k] = {
            name: v["name"],
            finishedAt: typeof v["finishedAt"] === "string" ? v["finishedAt"] : "",
            model: typeof v["model"] === "string" ? v["model"] : "",
            exitCode: typeof v["exitCode"] === "number" ? v["exitCode"] : null,
            timedOut: v["timedOut"] === true,
            modelNotFound: v["modelNotFound"] === true,
            eventLines: typeof v["eventLines"] === "number" ? v["eventLines"] : 0,
            sentinelHits: Array.isArray(v["sentinelHits"]) ? v["sentinelHits"].map((s: unknown) => String(s)) : [],
            pluginsListed: v["pluginsListed"],
          };
        }
      }
      return { model: typeof parsed["model"] === "string" ? parsed["model"] : MODEL, done };
    }
  } catch (e) {
    if (!(e instanceof Error && Reflect.get(e, "code") === "ENOENT")) {
      console.error(`state unreadable, starting fresh: ${errText(e)}`);
    }
  }
  return { model: MODEL, done: {} };
}

async function writeState(state: State): Promise<void> {
  await mkdir(artifactPath("state"), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadSentinels(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(artifactPath("sentinels.json"), "utf8"));
    const raw: unknown = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed["sentinels"] : undefined;
    if (!Array.isArray(raw)) return [];
    const items: unknown[] = raw;
    return items.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch (e) {
    if (!(e instanceof Error && Reflect.get(e, "code") === "ENOENT")) {
      console.error(`sentinels.json unreadable: ${errText(e)}`);
    }
    return [];
  }
}

async function analyze(outDir: string, sentinels: string[]): Promise<{ hits: string[]; lines: number; plugins: unknown }> {
  const hits = new Set<string>();
  const bodiesDir = join(outDir, "bodies");
  let names: string[] = [];
  try {
    names = await readdir(bodiesDir);
  } catch (e) {
    if (!(e instanceof Error && Reflect.get(e, "code") === "ENOENT")) throw e;
  }
  for (const name of names) {
    const text = await readFile(join(bodiesDir, name), "utf8");
    for (const s of sentinels) if (text.includes(s)) hits.add(s);
  }
  let lines = 0;
  let plugins: unknown;
  try {
    const events = (await readFile(join(outDir, "events.jsonl"), "utf8")).split("\n").filter((l) => l.length > 0);
    lines = events.length;
    for (const line of events) {
      try {
        const obj: unknown = JSON.parse(line);
        if (!isRecord(obj)) continue;
        if (obj["hook"] === "setup" && plugins === undefined) {
          plugins = obj["plugins"] ?? obj["pluginsError"];
        } else if (obj["hook"] === "context") {
          const system: unknown = obj["system"];
          if (Array.isArray(system)) {
            const texts: unknown[] = system;
            for (const text of texts) {
              if (typeof text !== "string") continue;
              for (const s of sentinels) if (text.includes(s)) hits.add(s);
            }
          }
        }
      } catch (e) {
        console.error(`bad events.jsonl line: ${errText(e)}`);
      }
    }
  } catch (e) {
    if (!(e instanceof Error && Reflect.get(e, "code") === "ENOENT")) throw e;
  }
  return { hits: [...hits], lines, plugins };
}

async function runScenario(sc: Scenario, opencode: string, sentinels: string[]): Promise<ScenarioResult> {
  const sandbox = join(PROBE_ROOT, sc.name);
  const outDir = join(PROBE_OUT_ROOT, sc.name);
  const logPath = join(outDir, "events.jsonl");
  const bodyDir = join(outDir, "bodies");

  await mkdir(PROBE_ROOT, { recursive: true });
  await freshDir(PROBE_ROOT, sandbox);
  await freshDir(PROBE_OUT_ROOT, outDir);
  await mkdir(bodyDir, { recursive: true });
  const git = await spawnWait(["git", "init", "-q"], sandbox);
  if (git.exitCode !== 0) throw new Error(`git init failed in ${sandbox}: ${git.stderr.slice(0, 300)}`);

  // Isolated global config (fresh each scenario).
  let env: Record<string, string> = {};
  const globalPlugins = sc.plugins.filter((p) => p.where === "global").map((p) => pluginEntry(p, logPath, bodyDir));
  const projectPlugins = sc.plugins.filter((p) => p.where === "project").map((p) => pluginEntry(p, logPath, bodyDir));
  if (sc.variant === "xdg") {
    await freshDir(ARTIFACTS, ISOLATION_XDG_CONFIG);
    await ensureIsolationDirs();
    if (globalPlugins.length > 0) {
      await writeFile(
        join(ISOLATION_XDG_CONFIG, "opencode", "opencode.json"),
        JSON.stringify(baseConfig(globalPlugins), null, 2),
      );
    }
    env = isolationEnv();
  } else if (globalPlugins.length > 0) {
    throw new Error(`${sc.name}: global plugins require an isolated variant`);
  }
  await writeFile(join(sandbox, "opencode.json"), JSON.stringify(baseConfig(projectPlugins), null, 2));

  const standaloneArgs = sc.standalone ? ["--standalone", "--print-logs", "--log-level", "info"] : [];
  const argv = [opencode, "run", ...standaloneArgs, "--auto", "--format", "json", "-m", MODEL, sc.prompt];
  const started = Date.now();
  const proc = Bun.spawn(argv, { cwd: sandbox, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const combined = `${stdout}\n${stderr}`;
  const modelNotFound = /model.{0,40}not found|ProviderModelNotFoundError|ModelNotFound/i.test(combined);
  const analysis = await analyze(outDir, sentinels);
  const result: ScenarioResult = {
    name: sc.name,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    exitCode: timedOut ? null : exitCode,
    timedOut,
    modelNotFound,
    eventLines: analysis.lines,
    sentinelHits: analysis.hits,
    pluginsListed: analysis.plugins,
  };
  await writeFile(
    join(outDir, "run.json"),
    JSON.stringify(
      {
        ...result,
        scenario: sc,
        durationMs: Date.now() - started,
        isolationEnv: env,
        stdout: stdout.slice(0, MAX_CAPTURE),
        stderr: stderr.slice(0, MAX_STDERR),
        pluginLog: stderr
          .split(/\r?\n/)
          .filter((l) => PLUGIN_LOG_RE.test(l))
          .slice(0, MAX_PLUGIN_LOG_LINES),
      },
      null,
      2,
    ),
  );
  return result;
}

async function main(): Promise<void> {
  if (process.argv.includes("--reset")) {
    await rm(await assertUnder(ARTIFACTS, STATE_FILE), { force: true });
    console.log("state reset");
  }
  const opencode = Bun.which("opencode");
  if (opencode === null) throw new Error("opencode not found on PATH");

  const scenarios = buildScenarios();
  const state = await readState();
  const pending = scenarios.filter((s) => state.done[s.name] === undefined);
  const lines: string[] = [`model=${MODEL} total=${scenarios.length} pending=${pending.length}`];

  if (pending.length > 0) {
    await buildProbes();
    const sentinels = await loadSentinels();
    lines.push(`sentinels loaded: ${sentinels.length}`);
    for (const sc of pending.slice(0, MAX_RUNS_PER_INVOCATION)) {
      try {
        const r = await runScenario(sc, opencode, sentinels);
        state.done[sc.name] = r;
        await writeState(state);
        lines.push(
          `${sc.name}: exit=${String(r.exitCode)}${r.timedOut ? " TIMEOUT" : ""}${r.modelNotFound ? " MODEL-NOT-FOUND" : ""} events=${r.eventLines} sentinelHits=${r.sentinelHits.length} plugins=${JSON.stringify(r.pluginsListed ?? null).slice(0, 160)}`,
        );
      } catch (e) {
        lines.push(`${sc.name}: RUNNER-ERROR ${errText(e).slice(0, 300)} (will retry next invocation)`);
      }
    }
  }

  const remaining = scenarios.filter((s) => state.done[s.name] === undefined).length;
  lines.push(remaining === 0 ? "COMPLETE" : `INCOMPLETE: ${remaining} scenario(s) remaining; run again`);
  console.log(lines.join("\n").slice(0, SUMMARY_LIMIT));
}

main().catch((e: unknown) => {
  console.error(errText(e));
  process.exit(1);
});
