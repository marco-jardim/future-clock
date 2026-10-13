// Runtime probe plugin for opencode v2. Two instances (A/B) log hook activity as JSONL so the
// orchestrator can learn hook ordering, mutation visibility and plugin isolation.
// Never persists request headers (only content-type / content-encoding values) or secrets.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Plugin } from "@opencode/plugin";

export type ProbeId = "A" | "B";

interface Registration {
  dispose(): Promise<void>;
}

const SEQ_KEY = Symbol.for("future-clock.probe.seq");
const SYS_MARK = "[[PROBE-SYS]]";
const DESC_MARK = " [[PROBE-DESC]]";
const TOOL_MARK = "\n[[PROBE-TOOL]]";
const BODY_MARK = "[[PROBE-BODY]]";

function nextSeq(): number {
  const current = Reflect.get(globalThis, SEQ_KEY);
  const next = (typeof current === "number" ? current : 0) + 1;
  Reflect.set(globalThis, SEQ_KEY, next);
  return next;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const s = JSON.stringify(v, (_k, val: unknown) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return "[function]";
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      return val;
    });
    return s ?? "null";
  } catch (e) {
    return JSON.stringify({ stringifyError: errText(e) });
  }
}

function optString(options: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = options[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optBool(options: Readonly<Record<string, unknown>>, key: string): boolean {
  return options[key] === true;
}

/** Text parts of a tool result `content` (string or array of parts). */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const items: unknown[] = content;
  const out: string[] = [];
  for (const item of items) {
    if (isRecord(item) && item["type"] === "text" && typeof item["text"] === "string") out.push(item["text"]);
  }
  return out;
}

/** Every string stored under a "text" key, anywhere in `value`. */
function collectTexts(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    for (const item of items) collectTexts(item, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "text" && typeof v === "string") out.push(v);
    else collectTexts(v, out, depth + 1);
  }
}

function summarizeMessage(message: unknown): Record<string, unknown> {
  const full = safeStringify(message);
  const texts: string[] = [];
  collectTexts(message, texts);
  const dateTexts = texts.filter((t) => /date/i.test(t));
  return {
    summary: full.length > 2000 ? `${full.slice(0, 2000)}…[truncated ${full.length - 2000}]` : full,
    ...(dateTexts.length > 0 ? { dateTexts } : {}),
  };
}

export function makeProbe(id: ProbeId) {
  return Plugin.define({
    id: `future-probe-${id.toLowerCase()}`,
    async setup(ctx) {
      const options: Readonly<Record<string, unknown>> = ctx.options;
      const logPath = optString(options, "log");
      const mutate = optBool(options, "mutate");
      const reanchor = optBool(options, "reanchor");
      const bodyDir = optString(options, "bodyDir");

      const record = (entry: Record<string, unknown>): void => {
        const line = safeStringify({ probe: id, ...entry });
        if (logPath === undefined) {
          console.error(`[probe-${id}] no log option; dropped: ${line.slice(0, 200)}`);
          return;
        }
        try {
          mkdirSync(dirname(logPath), { recursive: true });
          appendFileSync(logPath, `${line}\n`);
        } catch (e) {
          console.error(`[probe-${id}] log write failed: ${errText(e)}`);
        }
      };

      const base = (hook: string, sessionID: unknown): Record<string, unknown> => ({
        hook,
        seq: nextSeq(),
        t: Date.now(),
        sessionID: typeof sessionID === "string" ? sessionID : undefined,
      });

      // 1. setup line
      let plugins: unknown;
      let pluginsError: string | undefined;
      try {
        plugins = await ctx.plugin.list();
      } catch (e) {
        pluginsError = errText(e);
      }
      record({
        hook: "setup",
        seq: nextSeq(),
        t: Date.now(),
        plugins,
        pluginsError,
        optionsKeys: Object.keys(options),
        mutate,
        reanchor,
      });

      // 2. hooks
      let contextReanchored = false;
      const registrations: Registration[] = [];
      let contextReg: Registration | undefined;

      const registerContext = (): Promise<Registration> =>
        ctx.session.hook("context", async (event) => {
          const entry = base("context", event.sessionID);
          try {
            const agent: unknown = event.agent;
            const toolNames = Object.keys(event.tools);
            const yearDescriptions: Record<string, string> = {};
            for (const [name, tool] of Object.entries(event.tools)) {
              if (/year/i.test(tool.description)) yearDescriptions[name] = tool.description;
            }
            const result: Record<string, unknown> = {
              ...entry,
              agent: typeof agent === "string" ? agent : safeStringify(agent),
              system: event.system.map((s) => s.text),
              toolNames,
              yearDescriptions,
              messageCount: event.messages.length,
              messages: event.messages.map((m) => summarizeMessage(m)),
            };
            if (mutate) {
              event.system.push({ type: "text", text: SYS_MARK });
              const web = event.tools["websearch"];
              if (web !== undefined) {
                web.description = `${web.description}${DESC_MARK}`;
                result["descMutatedTool"] = "websearch";
              } else {
                const firstName = toolNames[0];
                const first = firstName === undefined ? undefined : event.tools[firstName];
                if (firstName !== undefined && first !== undefined) {
                  first.description = `${first.description}${DESC_MARK}`;
                  result["descMutatedTool"] = firstName;
                }
              }
              result["mutated"] = true;
            }
            record(result);
          } catch (e) {
            record({ ...entry, error: errText(e) });
          }

          if (reanchor && !contextReanchored) {
            contextReanchored = true;
            try {
              await contextReg?.dispose();
              contextReg = await registerContext();
              registrations.push(contextReg);
              record({ ...base("reanchor", event.sessionID), reregistered: true });
            } catch (e) {
              record({ ...base("reanchor", event.sessionID), error: errText(e) });
            }
          }
        });

      try {
        contextReg = await registerContext();
        registrations.push(contextReg);
        record({ hook: "register", seq: nextSeq(), t: Date.now(), target: "context", ok: true });
      } catch (e) {
        record({ hook: "register", seq: nextSeq(), t: Date.now(), target: "context", ok: false, error: errText(e) });
      }

      try {
        const reg = await ctx.session.hook("http.request", async (event) => {
          const entry = base("http.request", event.sessionID);
          try {
            const req = event.request;
            let bodyText = "";
            let bodyError: string | undefined;
            try {
              bodyText = await req.clone().text();
            } catch (e) {
              bodyError = errText(e);
            }
            let urlInfo = req.url;
            try {
              const u = new URL(req.url);
              urlInfo = `${u.origin}${u.pathname}`; // query stripped: may carry credentials
            } catch (e) {
              urlInfo = `unparseable-url (${errText(e)})`;
            }
            const agent: unknown = event.agent;
            const result: Record<string, unknown> = {
              ...entry,
              kind: event.kind,
              agent: typeof agent === "string" ? agent : safeStringify(agent),
              url: urlInfo,
              method: req.method,
              contentType: req.headers.get("content-type"),
              contentEncoding: req.headers.get("content-encoding"),
              bodyLength: bodyText.length,
              bodyError,
              hasSysMark: bodyText.includes(SYS_MARK),
              hasDescMark: bodyText.includes("[[PROBE-DESC]]"),
              hasToolMark: bodyText.includes("[[PROBE-TOOL]]"),
            };
            if (bodyDir !== undefined) {
              try {
                const file = join(bodyDir, `${String(entry["seq"])}-${id}-${event.kind}.json`);
                mkdirSync(bodyDir, { recursive: true });
                writeFileSync(file, bodyText);
                result["bodyFile"] = file;
              } catch (e) {
                result["bodySaveError"] = errText(e);
              }
            }
            if (mutate && bodyText.includes(SYS_MARK)) {
              if (req.headers.get("content-encoding")) {
                result["replaced"] = false;
                result["replaceSkipped"] = "content-encoding present";
              } else {
                const headers = new Headers(req.headers);
                headers.delete("content-length");
                const newBody = bodyText.split(SYS_MARK).join(BODY_MARK);
                event.request = new Request(req.url, { method: req.method, headers, body: newBody });
                result["replaced"] = true;
                result["newBodyLength"] = newBody.length;
              }
            }
            record(result);
          } catch (e) {
            record({ ...entry, error: errText(e) });
          }
        });
        registrations.push(reg);
        record({ hook: "register", seq: nextSeq(), t: Date.now(), target: "http.request", ok: true });
      } catch (e) {
        record({ hook: "register", seq: nextSeq(), t: Date.now(), target: "http.request", ok: false, error: errText(e) });
      }

      try {
        const reg = await ctx.tool.hook("execute.after", async (event) => {
          const entry = base("execute.after", event.sessionID);
          try {
            const result: Record<string, unknown> = {
              ...entry,
              tool: event.tool,
              status: event.status,
              input: safeStringify(event.input),
            };
            if (event.status === "completed") {
              const r = event.result;
              result["resultKeys"] = Object.keys(r);
              result["output"] = typeof r.output === "string" ? r.output : undefined;
              result["contentTexts"] = textsOf(r.content);
              if (mutate && event.tool === "shell") {
                const next = { ...r };
                if (typeof next.output === "string") next.output = `${next.output}${TOOL_MARK}`;
                if (typeof next.content === "string") {
                  next.content = `${next.content}${TOOL_MARK}`;
                } else if (next.content !== undefined) {
                  next.content = next.content.map((part) =>
                    part.type === "text" ? { ...part, text: `${part.text}${TOOL_MARK}` } : part,
                  );
                }
                event.result = next;
                result["mutated"] = true;
              }
            } else {
              result["error"] = safeStringify(event.error);
            }
            record(result);
          } catch (e) {
            record({ ...entry, error: errText(e) });
          }
        });
        registrations.push(reg);
        record({ hook: "register", seq: nextSeq(), t: Date.now(), target: "execute.after", ok: true });
      } catch (e) {
        record({ hook: "register", seq: nextSeq(), t: Date.now(), target: "execute.after", ok: false, error: errText(e) });
      }

      return async () => {
        for (const reg of registrations) {
          try {
            await reg.dispose();
          } catch (e) {
            record({ hook: "cleanup", seq: nextSeq(), t: Date.now(), error: errText(e) });
          }
        }
      };
    },
  });
}
