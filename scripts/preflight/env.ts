// Preflight environment capture (plan B.1.7 / G.1). Run: `bun run preflight`.
// Captures U1/U6/U7/U11/U14 facts + isolation sentinels into the artifacts dir (outside the repo).
// Secrets: only env var NAMES (presence booleans) and file NAMES are recorded; config text is redacted.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, TEMP_ROOT, artifactPath } from "../lib/artifacts";

// ---------------------------------------------------------------- types

interface CmdRecord {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
  durationMs: number;
}

interface PluginConfigInfo {
  file: string;
  parsed: boolean;
  pluginEntries: string[];
  parseError: string | null;
  redactedRaw: string | null;
}

interface SentinelFile {
  file: string;
  sentinels: string[];
}

interface RouterSearch {
  entry: string;
  kind: "local-path" | "package";
  searched: string[];
  roots: string[];
  filesScanned: number;
  filesTruncated: boolean;
  matchLines: number;
  notes: string[];
}

type Kind = "file" | "dir" | "missing";

// ---------------------------------------------------------------- helpers

const MAX_SUMMARY_BYTES = 4000;
const HOOK_RE = /\.hook\(|\.transform\(|"http\.request"|"execute\.after"|"context"/;
const SECRET_LINE_RE = /\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+\S{20,}|(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*\S+/i;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): unknown {
  return e instanceof Error ? Reflect.get(e, "code") : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function pathKind(p: string): Promise<Kind> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? "dir" : "file";
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw e;
  }
}

/** Spawn with explicit argv (no shell); records everything, never truncates. */
async function runCmd(argv: string[], timeoutMs = 60_000): Promise<CmdRecord> {
  const started = Date.now();
  try {
    const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { argv, exitCode, stdout, stderr, timedOut, error: null, durationMs: Date.now() - started };
  } catch (e) {
    return { argv, exitCode: null, stdout: "", stderr: "", timedOut: false, error: errMsg(e), durationMs: Date.now() - started };
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function cmdBrief(r: CmdRecord): string {
  if (r.error !== null) return `ERR(${oneLine(r.error, 80)})`;
  return `exit=${r.exitCode}${r.timedOut ? " TIMEOUT" : ""} out=${r.stdout.length}B err=${r.stderr.length}B`;
}

/** Strip // and block comments (string-aware), BOM and trailing commas so JSON.parse can read JSONC. */
function stripJsonc(input: string): string {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src.charAt(i) !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "}" || ch === "]") out = out.replace(/,\s*$/, "");
    out += ch;
    i += 1;
  }
  return out;
}

function redactRaw(raw: string): string {
  return raw
    .replace(/("?[\w-]*(?:key|token|secret|password|authorization)[\w-]*"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, '$1"[REDACTED]"')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S{20,}/g, "Bearer [REDACTED]");
}

function pluginEntryName(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const first: unknown = v[0];
    return pluginEntryName(first);
  }
  if (isRecord(v)) {
    for (const key of ["package", "name", "path", "module", "plugin"]) {
      const val = v[key];
      if (typeof val === "string") return val;
    }
  }
  return null;
}

function extractPluginEntries(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const names: string[] = [];
  for (const key of ["plugin", "plugins"]) {
    const val = parsed[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const n = pluginEntryName(item);
        if (n !== null) names.push(n);
      }
    } else if (isRecord(val)) {
      names.push(...Object.keys(val));
    } else if (typeof val === "string") {
      names.push(val);
    }
  }
  return names;
}

function pluginNamesFromRaw(raw: string): string[] {
  const names: string[] = [];
  const blockRe = /"plugins?"\s*:\s*\[([^\]]*)\]/g;
  for (const m of raw.matchAll(blockRe)) {
    const body = m[1] ?? "";
    for (const q of body.matchAll(/"([^"]+)"/g)) {
      const s = q[1];
      if (s !== undefined) names.push(s);
    }
  }
  return names;
}

// ---------------------------------------------------------------- group 1: opencode / tool versions

const OPENCODE_COMMANDS: ReadonlyArray<{ label: string; args: string[] }> = [
  { label: "--version", args: ["--version"] },
  { label: "debug paths", args: ["debug", "paths"] },
  { label: "run --help", args: ["run", "--help"] },
  { label: "plugin --help", args: ["plugin", "--help"] },
  { label: "debug --help", args: ["debug", "--help"] },
];

interface ToolsCapture {
  opencodePath: string | null;
  pwshPath: string | null;
  bunPath: string | null;
  opencode: Record<string, CmdRecord>;
  bunVersion: CmdRecord;
  pwshVersion: CmdRecord;
}

async function captureTools(): Promise<ToolsCapture> {
  const opencodePath = Bun.which("opencode");
  const pwshPath = Bun.which("pwsh");
  const bunPath = Bun.which("bun");
  const opencode: Record<string, CmdRecord> = {};
  for (const c of OPENCODE_COMMANDS) {
    opencode[c.label] = await runCmd([opencodePath ?? "opencode", ...c.args]);
  }
  const bunVersion = await runCmd([bunPath ?? "bun", "--version"]);
  const pwshVersion = await runCmd([pwshPath ?? "pwsh", "-v"]);
  return { opencodePath, pwshPath, bunPath, opencode, bunVersion, pwshVersion };
}

function parseDebugPaths(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w-]*)\s+(\S.*?)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) result[m[1]] = m[2];
  }
  return result;
}

// ---------------------------------------------------------------- group 2: U7 clock

const CULTURES = ["en-US", "pt-BR"] as const;
const CLOCK_EXPRS: ReadonlyArray<{ label: string; expr: string }> = [
  { label: "Get-Date", expr: "Get-Date" },
  { label: "Get-Date -Format o", expr: "Get-Date -Format o" },
  { label: "(Get-Date).Year", expr: "(Get-Date).Year" },
  { label: "Get-Date -Format yyyyMMdd", expr: "Get-Date -Format yyyyMMdd" },
  { label: "Get-Date | Format-List", expr: "Get-Date | Format-List" },
  { label: "(Get-Date).DayOfWeek", expr: "(Get-Date).DayOfWeek" },
  { label: "[DateTime]::Now.ToString()", expr: "[DateTime]::Now.ToString()" },
];
// UTF-8 output so non-ASCII names (e.g. pt-BR weekday/month) are not mangled by the console code page.
const UTF8_PREFIX = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";

interface ClockCapture {
  realNow: { iso: string; localYear: number; localString: string; timezoneOffsetMinutes: number };
  defaultCulture: CmdRecord;
  defaultConsoleOutputEncoding: CmdRecord;
  utf8Prefix: string;
  cultures: Record<string, Record<string, CmdRecord>>;
}

async function captureClock(pwsh: string): Promise<ClockCapture> {
  const now = new Date();
  const cultures: Record<string, Record<string, CmdRecord>> = {};
  for (const c of CULTURES) {
    const perCulture: Record<string, CmdRecord> = {};
    const setCulture = `[System.Threading.Thread]::CurrentThread.CurrentCulture = '${c}'; [cultureinfo]::CurrentCulture = '${c}'; `;
    for (const e of CLOCK_EXPRS) {
      perCulture[e.label] = await runCmd([pwsh, "-NoProfile", "-Command", `${UTF8_PREFIX}${setCulture}${e.expr}`]);
    }
    cultures[c] = perCulture;
  }
  const defaultCulture = await runCmd([pwsh, "-NoProfile", "-Command", "(Get-Culture).Name"]);
  const defaultConsoleOutputEncoding = await runCmd([pwsh, "-NoProfile", "-Command", "[Console]::OutputEncoding.WebName"]);
  return {
    realNow: {
      iso: now.toISOString(),
      localYear: now.getFullYear(),
      localString: now.toString(),
      timezoneOffsetMinutes: now.getTimezoneOffset(),
    },
    defaultCulture,
    defaultConsoleOutputEncoding,
    utf8Prefix: UTF8_PREFIX,
    cultures,
  };
}

// ---------------------------------------------------------------- group 3: sentinels

function pickSentinels(text: string, max = 5): string[] {
  const scored: Array<{ line: string; score: number; idx: number }> = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = (lines[idx] ?? "").trim();
    if (line.length < 25 || line.length > 120) continue;
    if (!/[A-Za-z]{4,}/.test(line)) continue;
    if (line.startsWith("```") || /^[-|:\s=*_]+$/.test(line)) continue;
    if (SECRET_LINE_RE.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    let score = 0;
    if (/Protocol|Sisyphus|Delegation|orchestrator/i.test(line)) score += 3;
    if (line.startsWith("#")) score += 2;
    if (line.length >= 40 && line.length <= 100) score += 1;
    scored.push({ line, score, idx });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored
    .slice(0, max)
    .sort((a, b) => a.idx - b.idx)
    .map((s) => s.line);
}

interface SentinelCapture {
  dirs: Array<{ dir: string; exists: boolean }>;
  files: SentinelFile[];
  configs: PluginConfigInfo[];
  pluginNames: string[];
  sentinels: string[];
}

async function captureSentinels(configDir: string | null): Promise<SentinelCapture> {
  const candidates: string[] = [];
  candidates.push(configDir ?? join(homedir(), ".config", "opencode"));
  candidates.push(join(homedir(), ".config", "Claude"));
  const dirs: Array<{ dir: string; exists: boolean }> = [];
  for (const dir of candidates) dirs.push({ dir, exists: (await pathKind(dir)) === "dir" });

  const files: SentinelFile[] = [];
  const configs: PluginConfigInfo[] = [];
  for (const { dir, exists } of dirs) {
    if (!exists) continue;
    const names = await readdir(dir);
    for (const name of names.sort()) {
      if (/^(agents|claude)\.md$/i.test(name)) {
        const full = join(dir, name);
        if ((await pathKind(full)) !== "file") continue;
        files.push({ file: full, sentinels: pickSentinels(await readFile(full, "utf8")) });
      }
    }
    for (const cfg of ["opencode.json", "opencode.jsonc"]) {
      const full = join(dir, cfg);
      if ((await pathKind(full)) !== "file") continue;
      const raw = await readFile(full, "utf8");
      try {
        const parsed: unknown = JSON.parse(stripJsonc(raw));
        configs.push({ file: full, parsed: true, pluginEntries: extractPluginEntries(parsed), parseError: null, redactedRaw: null });
      } catch (e) {
        configs.push({
          file: full,
          parsed: false,
          pluginEntries: pluginNamesFromRaw(raw),
          parseError: errMsg(e),
          redactedRaw: redactRaw(raw),
        });
      }
    }
  }
  const pluginNames = [...new Set(configs.flatMap((c) => c.pluginEntries))];
  const sentinels = [...new Set([...files.flatMap((f) => f.sentinels), ...pluginNames])];
  return { dirs, files, configs, pluginNames, sentinels };
}

// ---------------------------------------------------------------- group 4: U14 router hooks

function isLocalPathEntry(entry: string): boolean {
  return /^(file:|\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|[\\/])/.test(entry);
}

function packageNameOf(entry: string): string {
  const noPrefix = entry.replace(/^npm:/, "");
  const m = /^(@[^/@]+\/[^/@]+|[^/@]+)(?:@.*)?$/.exec(noPrefix);
  return m?.[1] ?? noPrefix;
}

const SOURCE_EXT_RE = /\.(?:ts|js|mts|mjs)$/;
const MAX_FILES = 2000;

async function collectSourceFiles(root: string, notes: string[]): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const stack: string[] = [root];
  let truncated = false;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      notes.push(`readdir failed ${dir}: ${errMsg(e)}`);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        subdirs.push(join(dir, ent.name));
      } else if (ent.isFile() && SOURCE_EXT_RE.test(ent.name)) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          break;
        }
        files.push(join(dir, ent.name));
      }
    }
    if (truncated) break;
    for (let i = subdirs.length - 1; i >= 0; i -= 1) {
      const sd = subdirs[i];
      if (sd !== undefined) stack.push(sd);
    }
  }
  return { files, truncated };
}

/** Bounded search for directories whose name contains `needle` (descends into node_modules). */
async function findDirsByName(root: string, needle: string, notes: string[]): Promise<string[]> {
  const hits: string[] = [];
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && visited < 3000 && hits.length < 3) {
    const item = queue.shift();
    if (item === undefined) break;
    visited += 1;
    let entries;
    try {
      entries = await readdir(item.dir, { withFileTypes: true });
    } catch (e) {
      const code = errCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR") notes.push(`scan readdir failed ${item.dir}: ${errMsg(e)}`);
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === ".git") continue;
      const full = join(item.dir, ent.name);
      if (ent.name.toLowerCase().includes(needle) && ent.name !== "node_modules") {
        hits.push(full);
        continue;
      }
      if (item.depth < 3) queue.push({ dir: full, depth: item.depth + 1 });
    }
  }
  return hits;
}

function clip(line: string): string {
  return line.length > 500 ? `${line.slice(0, 500)} ...[+${line.length - 500} chars]` : line;
}

function grepFile(file: string, text: string): { out: string[]; matches: number } {
  const lines = text.split(/\r?\n/);
  const hitIdx: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (HOOK_RE.test(lines[i] ?? "")) hitIdx.push(i);
  }
  if (hitIdx.length === 0) return { out: [], matches: 0 };
  const ranges: Array<{ s: number; e: number }> = [];
  for (const h of hitIdx) {
    const s = Math.max(0, h - 5);
    const e = Math.min(lines.length - 1, h + 5);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && s <= last.e + 1) last.e = Math.max(last.e, e);
    else ranges.push({ s, e });
  }
  const hitSet = new Set(hitIdx);
  const out: string[] = [`=== ${file} (${hitIdx.length} matching lines)`];
  for (const r of ranges.slice(0, 200)) {
    for (let i = r.s; i <= r.e; i += 1) {
      out.push(`${hitSet.has(i) ? ">" : " "}${String(i + 1).padStart(5)}: ${clip(lines[i] ?? "")}`);
    }
    out.push("  ----");
  }
  if (ranges.length > 200) out.push(`  (capped: ${ranges.length - 200} further blocks omitted)`);
  return { out, matches: hitIdx.length };
}

function resolveLocalEntry(entry: string, configDir: string): string {
  if (entry.startsWith("file:")) return fileURLToPath(new URL(entry));
  if (entry.startsWith("~")) return join(homedir(), entry.slice(1));
  return resolve(configDir, entry);
}

interface RouterCapture {
  outputFile: string;
  considered: string[];
  searches: RouterSearch[];
}

async function captureRouterHooks(
  pluginNames: string[],
  configDir: string,
  paths: Record<string, string>,
  outputFile: string,
): Promise<RouterCapture> {
  const considered = pluginNames.filter((p) => isLocalPathEntry(p) || /router/i.test(p));
  const report: string[] = [
    `# router-hooks (U14) captured ${new Date().toISOString()}`,
    `# pattern: ${HOOK_RE.source}  context: 5 lines  max files per entry: ${MAX_FILES}`,
    `# global plugin entries: ${JSON.stringify(pluginNames)}`,
    `# considered (local path or contains "router"): ${JSON.stringify(considered)}`,
    "",
  ];
  const searches: RouterSearch[] = [];

  const cacheCandidates = [paths["cache"], join(homedir(), ".cache", "opencode"), paths["data"]];
  const cacheRoots = [...new Set(cacheCandidates.filter((c): c is string => typeof c === "string"))];

  for (const entry of considered) {
    const search: RouterSearch = {
      entry,
      kind: isLocalPathEntry(entry) ? "local-path" : "package",
      searched: [],
      roots: [],
      filesScanned: 0,
      filesTruncated: false,
      matchLines: 0,
      notes: [],
    };
    try {
      if (search.kind === "local-path") {
        const target = resolveLocalEntry(entry, configDir);
        search.searched.push(target);
        const kind = await pathKind(target);
        if (kind === "dir") search.roots.push(target);
        else if (kind === "file") {
          let root = dirname(target);
          if (/^(dist|build|out|lib)$/i.test(basename(root))) root = dirname(root);
          search.roots.push(root);
        }
      } else {
        const name = packageNameOf(entry);
        const bases = [...new Set([configDir, ...cacheRoots])];
        for (const base of bases) {
          for (const cand of [join(base, "node_modules", name), join(base, name)]) {
            search.searched.push(cand);
            if ((await pathKind(cand)) === "dir") search.roots.push(cand);
          }
        }
        if (search.roots.length === 0) {
          const needle = (name.split("/").pop() ?? name).toLowerCase();
          for (const base of bases) {
            search.searched.push(`scan(depth<=3, contains "${needle}"): ${base}`);
            search.roots.push(...(await findDirsByName(base, needle, search.notes)));
          }
        }
      }
    } catch (e) {
      search.notes.push(`resolve failed: ${errMsg(e)}`);
    }

    report.push(`## entry: ${entry} (${search.kind})`);
    report.push(`searched:`, ...search.searched.map((s) => `  - ${s}`));
    if (search.roots.length === 0) report.push("NOT FOUND: no source location resolved");
    for (const root of [...new Set(search.roots)]) {
      report.push(`source root: ${root}`);
      const { files, truncated } = await collectSourceFiles(root, search.notes);
      search.filesScanned += files.length;
      search.filesTruncated = search.filesTruncated || truncated;
      for (const file of files) {
        try {
          const text = await readFile(file, "utf8");
          const g = grepFile(file, text);
          search.matchLines += g.matches;
          report.push(...g.out);
        } catch (e) {
          search.notes.push(`read failed ${file}: ${errMsg(e)}`);
        }
      }
    }
    report.push(`files scanned: ${search.filesScanned}${search.filesTruncated ? " (TRUNCATED at limit)" : ""}; matching lines: ${search.matchLines}`);
    if (search.notes.length > 0) report.push("notes:", ...search.notes.map((n) => `  - ${n}`));
    report.push("");
    searches.push(search);
  }
  if (considered.length === 0) report.push("No global plugin entry is a local path or contains \"router\"; nothing to search.");
  await writeFile(outputFile, `${report.join("\n")}\n`, "utf8");
  return { outputFile, considered, searches };
}

// ---------------------------------------------------------------- group 5: U11 auth

const CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "AZURE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GITHUB_TOKEN",
  "OPENCODE_API_KEY",
] as const;

interface AuthCapture {
  dataDir: string | null;
  dataDirExists: boolean;
  topLevelEntryCount: number;
  authLikeFileNames: string[];
  credentialEnvPresent: Record<string, boolean>;
  otherCredentialLikeEnvNames: string[];
}

async function captureAuth(dataDir: string | null): Promise<AuthCapture> {
  const credentialEnvPresent: Record<string, boolean> = {};
  for (const name of CREDENTIAL_ENV_NAMES) {
    const v = process.env[name];
    credentialEnvPresent[name] = v !== undefined && v !== "";
  }
  const known = new Set<string>(CREDENTIAL_ENV_NAMES);
  const otherCredentialLikeEnvNames = Object.keys(process.env)
    .filter((k) => /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k) && !known.has(k))
    .sort();
  let authLikeFileNames: string[] = [];
  let topLevelEntryCount = 0;
  let dataDirExists = false;
  if (dataDir !== null && (await pathKind(dataDir)) === "dir") {
    dataDirExists = true;
    const names = await readdir(dataDir);
    topLevelEntryCount = names.length;
    authLikeFileNames = names.filter((n) => /auth|credential|token|secret|oauth|\.key$|\.pem$/i.test(n)).sort();
  }
  return { dataDir, dataDirExists, topLevelEntryCount, authLikeFileNames, credentialEnvPresent, otherCredentialLikeEnvNames };
}

// ---------------------------------------------------------------- summary

function clockLine(label: string, r: CmdRecord | undefined): string {
  if (r === undefined) return `  ${label}: (missing)`;
  const body = r.error !== null ? `ERR ${r.error}` : oneLine(r.stdout, 110);
  return `  ${label}: ${body}${r.exitCode !== 0 && r.error === null ? ` [exit ${r.exitCode}]` : ""}`;
}

function fitSummary(lines: string[]): string {
  let text = lines.join("\n");
  const tail = "\n[summary truncated; full data in preflight-env.json]";
  while (Buffer.byteLength(text, "utf8") > MAX_SUMMARY_BYTES) {
    text = text.slice(0, Math.max(0, text.length - 200)).replace(/\n[^\n]*$/, "");
    if (Buffer.byteLength(text + tail, "utf8") <= MAX_SUMMARY_BYTES) {
      text += tail;
      break;
    }
  }
  return text;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const errors: Record<string, string> = {};
  async function capture<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      errors[name] = errMsg(e);
      return null;
    }
  }

  await mkdir(TEMP_ROOT, { recursive: true });
  await mkdir(ARTIFACTS, { recursive: true });

  const tools = await capture("tools", captureTools);
  const pathsRecord = tools?.opencode["debug paths"];
  const paths = pathsRecord ? parseDebugPaths(pathsRecord.stdout) : {};
  const configDir = paths["config"] ?? null;
  const dataDir = paths["data"] ?? null;
  if (tools !== null && configDir === null) errors["paths"] = "no `config` line found in `opencode debug paths` output";

  const pwsh = tools?.pwshPath ?? Bun.which("pwsh") ?? "pwsh";
  const clock = await capture("clock", () => captureClock(pwsh));
  const sentinelCap = await capture("sentinels", () => captureSentinels(configDir));

  if (sentinelCap !== null) {
    const sentinelsFile = artifactPath("sentinels.json");
    const source = `preflight env.ts ${new Date().toISOString()}: ${sentinelCap.files.map((f) => f.file).join("; ") || "(no AGENTS.md/CLAUDE.md found)"}; plugins from ${
      sentinelCap.configs.map((c) => c.file).join("; ") || "(no opencode config found)"
    }`;
    await capture("sentinels-write", () =>
      writeFile(sentinelsFile, `${JSON.stringify({ source, sentinels: sentinelCap.sentinels }, null, 2)}\n`, "utf8"),
    );
  }

  const routerFile = artifactPath("router-hooks.txt");
  const router = await capture("router-hooks", () =>
    captureRouterHooks(sentinelCap?.pluginNames ?? [], configDir ?? join(homedir(), ".config", "opencode"), paths, routerFile),
  );
  if (router === null) {
    await capture("router-hooks-fallback-write", () =>
      writeFile(routerFile, `router-hooks capture failed: ${errors["router-hooks"] ?? "unknown error"}\n`, "utf8"),
    );
  }

  const auth = await capture("auth", () => captureAuth(dataDir));

  const result = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    bunRuntimeVersion: Bun.version,
    cwd: process.cwd(),
    opencode: tools,
    opencodePaths: paths,
    clock,
    sentinels: sentinelCap,
    routerHooks: router,
    auth,
    errors,
  };
  const envFile = artifactPath("preflight-env.json");
  await writeFile(envFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  // ---- summary (<= 4 KiB)
  const L: string[] = [];
  L.push(`preflight captured ${result.capturedAt} -> ${envFile}`);
  if (tools !== null) {
    L.push(`opencode: ${tools.opencodePath ?? "NOT FOUND"}`);
    for (const c of OPENCODE_COMMANDS) {
      const r = tools.opencode[c.label];
      L.push(`  opencode ${c.label}: ${r ? cmdBrief(r) : "(missing)"}`);
    }
    const ver = tools.opencode["--version"];
    if (ver) L.push(`  opencode version: ${oneLine(ver.stdout, 60) || oneLine(ver.stderr, 60)}`);
    L.push(`bun ${oneLine(tools.bunVersion.stdout, 30)} | pwsh ${oneLine(tools.pwshVersion.stdout, 30)} (${tools.pwshPath ?? "not on PATH"})`);
  }
  L.push(`paths: ${Object.entries(paths).map(([k, v]) => `${k}=${v}`).join("; ") || "(none parsed)"}`);
  if (clock !== null) {
    L.push(`real now: ${clock.realNow.iso} (local year ${clock.realNow.localYear})`);
    L.push(`default culture: ${oneLine(clock.defaultCulture.stdout, 20)}; console enc: ${oneLine(clock.defaultConsoleOutputEncoding.stdout, 20)}`);
    for (const c of CULTURES) {
      L.push(`U7 ${c}:`);
      for (const e of CLOCK_EXPRS) L.push(clockLine(e.label, clock.cultures[c]?.[e.label]));
    }
  }
  if (sentinelCap !== null) {
    L.push(`sentinels: ${sentinelCap.sentinels.length} (${sentinelCap.files.length} md files, ${sentinelCap.configs.length} configs)`);
    L.push(`plugins: ${sentinelCap.pluginNames.join(", ") || "(none)"}`);
  }
  if (router !== null) {
    for (const s of router.searches) {
      L.push(`U14 ${s.entry}: roots=${s.roots.length} files=${s.filesScanned} matches=${s.matchLines}`);
    }
    if (router.searches.length === 0) L.push("U14: no candidate plugin entries");
  }
  if (auth !== null) {
    L.push(`U11 auth files in data dir: ${auth.authLikeFileNames.join(", ") || "(none)"}`);
    const present = Object.entries(auth.credentialEnvPresent).filter(([, v]) => v).map(([k]) => k);
    L.push(`U11 credential env present: ${present.join(", ") || "(none)"}; other cred-like names: ${auth.otherCredentialLikeEnvNames.length}`);
  }
  const errKeys = Object.keys(errors);
  L.push(errKeys.length > 0 ? `ERRORS: ${errKeys.map((k) => `${k}: ${oneLine(errors[k] ?? "", 100)}`).join(" | ")}` : "errors: none");
  console.log(fitSummary(L));

  const versionOk = tools?.opencode["--version"]?.exitCode === 0;
  if (errKeys.length > 0 || !versionOk) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`[preflight] fatal: ${errMsg(e)}`);
    process.exitCode = 1;
  });
}
