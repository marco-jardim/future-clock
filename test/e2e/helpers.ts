// Helpers for the dump-based end-to-end suite (plan §7.2). Needs real opencode + credentials.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { artifactPath } from "../../scripts/lib/artifacts";
import { runOpencode } from "../../scripts/lib/opencode-run";
import type { RunResult } from "../../scripts/lib/opencode-run";
import { createSandbox } from "../../scripts/sandbox";
import type { Arm } from "../../scripts/sandbox";
import { shiftYears } from "../../src/core/years";

/** Years offset used by the treatment sandbox (createSandbox default). */
export const SHIFT_YEARS = 120;
/** Per-run kill timeout; three retries must fit inside the 600 s test timeout. */
export const RUN_TIMEOUT_MS = 170_000;
export const TEST_TIMEOUT_MS = 600_000;

const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash", "powershell"]);
/** Primary dumps are every kind except the title-generation request. */
const IGNORED_KIND = "title";
const DUMP_NAME = /^(.+)-([A-Za-z0-9_]+)-(\d+)\.json$/;

export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; text: string };

export interface Message {
  role: string;
  blocks: Block[];
}

export interface ToolDescription {
  name: string;
  description: string;
}

export interface Dump {
  file: string;
  sessionID: string;
  kind: string;
  seq: number;
  system: string[];
  tools: ToolDescription[];
  messages: Message[];
}

export interface ShellResult {
  command: string;
  text: string;
}

export interface Sentinels {
  source: string;
  sentinels: string[];
}

export interface Scenario {
  run: RunResult;
  /** Parsed primary bodies (no title requests), ordered by seq. */
  bodies: Dump[];
  dumpDir: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function realYear(): number {
  return new Date().getFullYear();
}

export function shiftedYear(): number {
  return realYear() + SHIFT_YEARS;
}

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name.toLowerCase());
}

export function freshDumpDir(name: string): string {
  return artifactPath("dumps", `${name}-${Date.now()}`);
}

function contentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const parts: string[] = [];
  for (const item of v) {
    if (isRecord(item) && typeof item["text"] === "string") parts.push(item["text"]);
  }
  return parts.join("\n");
}

function parseBlock(v: unknown): Block | undefined {
  if (!isRecord(v)) return undefined;
  const type = v["type"];
  if (type === "text" && typeof v["text"] === "string") return { type: "text", text: v["text"] };
  if (type === "tool_use" && typeof v["id"] === "string" && typeof v["name"] === "string") {
    const input = isRecord(v["input"]) ? v["input"] : {};
    return { type: "tool_use", id: v["id"], name: v["name"], input };
  }
  if (type === "tool_result" && typeof v["tool_use_id"] === "string") {
    return { type: "tool_result", toolUseId: v["tool_use_id"], text: contentText(v["content"]) };
  }
  return undefined; // thinking, image, ... blocks carry no assertable text
}

function parseMessage(v: unknown): Message | undefined {
  if (!isRecord(v) || typeof v["role"] !== "string") return undefined;
  const content = v["content"];
  const blocks: Block[] = [];
  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const block = parseBlock(item);
      if (block !== undefined) blocks.push(block);
    }
  }
  return { role: v["role"], blocks };
}

function parseTools(v: unknown): ToolDescription[] {
  if (!Array.isArray(v)) return [];
  const tools: ToolDescription[] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item["name"] !== "string") continue;
    tools.push({ name: item["name"], description: typeof item["description"] === "string" ? item["description"] : "" });
  }
  return tools;
}

function parseSystem(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  const parts: string[] = [];
  for (const item of v) {
    if (typeof item === "string") parts.push(item);
    else if (isRecord(item) && typeof item["text"] === "string") parts.push(item["text"]);
  }
  return parts;
}

/** Parses the primary dump files (side files and title requests are ignored), ordered by seq. */
export async function loadBodies(dumps: string[]): Promise<Dump[]> {
  const out: Dump[] = [];
  for (const file of dumps) {
    const m = DUMP_NAME.exec(basename(file));
    if (m === null) continue; // .l3.json and other side files
    const sessionID = m[1];
    const kind = m[2];
    const seq = m[3];
    if (sessionID === undefined || kind === undefined || seq === undefined || kind === IGNORED_KIND) continue;
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(raw)) throw new Error(`dump is not a JSON object: ${file}`);
    const messages: Message[] = [];
    const rawMessages = raw["messages"];
    if (Array.isArray(rawMessages)) {
      for (const item of rawMessages) {
        const message = parseMessage(item);
        if (message !== undefined) messages.push(message);
      }
    }
    out.push({
      file,
      sessionID,
      kind,
      seq: Number(seq),
      system: parseSystem(raw["system"]),
      tools: parseTools(raw["tools"]),
      messages,
    });
  }
  return out.sort((a, b) => a.seq - b.seq || a.file.localeCompare(b.file));
}

/** Raw text of every dump file (including title and side files), for secret/sentinel scans. */
export async function readAllDumpText(dumps: string[]): Promise<string> {
  const parts = await Promise.all(dumps.map((file) => readFile(file, "utf8")));
  return parts.join("\n");
}

export function systemText(body: Dump): string {
  return body.system.join("\n");
}

export function toolDescriptions(body: Dump): ToolDescription[] {
  return body.tools;
}

function toolUsesById(body: Dump): Map<string, { name: string; input: Record<string, unknown> }> {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const message of body.messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_use") uses.set(block.id, { name: block.name, input: block.input });
    }
  }
  return uses;
}

/** tool_result texts whose tool_use is a shell tool, with the command that produced them. */
export function shellToolResults(body: Dump): ShellResult[] {
  const uses = toolUsesById(body);
  const out: ShellResult[] = [];
  for (const message of body.messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      const use = uses.get(block.toolUseId);
      if (use === undefined || !isShellTool(use.name)) continue;
      const command = use.input["command"];
      out.push({ command: typeof command === "string" ? command : "", text: block.text });
    }
  }
  return out;
}

/** tool_result texts whose tool_use is `read`. */
export function readToolResults(body: Dump): string[] {
  const uses = toolUsesById(body);
  const out: string[] = [];
  for (const message of body.messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_result") continue;
      if (uses.get(block.toolUseId)?.name === "read") out.push(block.text);
    }
  }
  return out;
}

/** True when `text` holds a date-shaped span (context mode, plan D6) carrying `year` (or year±1). */
export function hasDateShapedYear(text: string, year: number): boolean {
  return shiftYears({ text, realYear: year, years: 4, mode: "context" }).count > 0;
}

/** True when `year` appears as a standalone 4-digit token. */
export function hasYearToken(text: string, year: number): boolean {
  return new RegExp(`(?<!\\d)${year}(?!\\d)`).test(text);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /"(authorization|x-api-key)"\s*:\s*"/gi,
  /Bearer\s+\S{20,}/g,
];

/** Credential-looking matches (D13); the matches themselves are returned so a failure shows them. */
export function secretHits(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const m of text.matchAll(pattern)) hits.push(m[0]);
  }
  return hits;
}

/** Runs `fn` up to `tries` times until `isConclusive(result)`; throws if never conclusive. */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  isConclusive: (result: T) => boolean,
  tries = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const result = await fn();
    if (isConclusive(result)) return result;
  }
  throw new Error(`inconclusive after ${tries} tries: the model never made the requested tool call`);
}

export async function loadSentinels(): Promise<Sentinels> {
  const raw: unknown = JSON.parse(await readFile(artifactPath("sentinels.json"), "utf8"));
  if (!isRecord(raw) || typeof raw["source"] !== "string" || !Array.isArray(raw["sentinels"])) {
    throw new Error("sentinels.json: expected {source, sentinels[]}");
  }
  const sentinels = raw["sentinels"].filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
  return { source: raw["source"], sentinels };
}

export interface ScenarioOptions {
  name: string;
  arm: Arm;
  prompt: string;
  isolated: boolean;
}

/** Recreates the sandbox, runs one prompt with a fresh dump dir and parses the primary bodies. */
export async function runScenario(o: ScenarioOptions): Promise<Scenario> {
  const cwd = await createSandbox({ arm: o.arm });
  const dumpDir = freshDumpDir(o.name);
  const run = await runOpencode({
    cwd,
    prompt: o.prompt,
    isolated: o.isolated,
    dumpDir,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const bodies = await loadBodies(run.dumps);
  return { run, bodies, dumpDir };
}
