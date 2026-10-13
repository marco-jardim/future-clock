/**
 * Realistic Anthropic Messages request body as seen at the HTTP boundary
 * (opencode-go/claude-haiku-5-5, runtime shape verified in plan D9).
 * Real year in every date: 2026.
 */

export const SHELL_TOOL_USE_ID = "toolu_01ShellGetDate";
export const READ_TOOL_USE_ID = "toolu_01ReadNotes";

/** Observed `Get-Date` output on a pt-BR Windows host. */
export const PT_BR_GET_DATE_OUTPUT = "\r\nsegunda-feira, 12 de outubro de 2026 16:20:00\r\n\r\n";

export const SYSTEM_MAIN_TEXT =
  "You are opencode, an interactive CLI agent that helps users with software engineering tasks.\n" +
  "Here is some useful information about the environment you are running in:\n" +
  "<env>\n" +
  "  Working directory: D:\\work\\demo\n" +
  "  Is directory a git repo: yes\n" +
  "  Platform: win32\n" +
  "  Today's date: Mon Oct 12 2026\n" +
  "</env>";

/** System part injected by another plugin: "v2026" is a version, not a date. */
export const SYSTEM_ROUTER_TEXT =
  "Router protocol v2026: delegate sub-tasks through the router tool and report results verbatim.";

export const WEBSEARCH_DESCRIPTION =
  "Search the web for up-to-date information. The current year is 2026. Use this year when searching for recent information.";

export const READ_DESCRIPTION =
  "Reads a file from the local filesystem. Returns the content with line numbers.";

export const SHELL_DESCRIPTION = "Executes a shell command (pwsh) in the given working directory.";

export const USER_QUESTION = "que dia é hoje? meu arquivo é 2026-10-12.txt";

export const READ_OUTPUT = "1: reunião marcada em 2026-10-12\n2: revisar notas\n";

export const ROLLOVER_TEXT = "Lembrete: prazo em 2026-10-20.\r\nToday's date is now: Tue Oct 13 2026\r\n";

export interface WireTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface WireToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WireToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | WireTextBlock[];
  cache_control?: { type: "ephemeral" };
}

export type WireBlock = WireTextBlock | WireToolUseBlock | WireToolResultBlock;

export interface WireMessage {
  role: "user" | "assistant";
  content: string | WireBlock[];
}

export interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface WireBody {
  model: string;
  system: string | WireTextBlock[];
  messages: WireMessage[];
  tools: WireTool[];
  stream: boolean;
  max_tokens: number;
  thinking: { type: "enabled"; budget_tokens: number };
}

export const wireBody: WireBody = {
  model: "claude-haiku-5-5",
  system: [
    { type: "text", text: SYSTEM_MAIN_TEXT, cache_control: { type: "ephemeral" } },
    { type: "text", text: SYSTEM_ROUTER_TEXT },
  ],
  messages: [
    { role: "user", content: USER_QUESTION },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Vou verificar a data do sistema." },
        {
          type: "tool_use",
          id: SHELL_TOOL_USE_ID,
          name: "shell",
          input: { command: "Get-Date", workdir: "D:\\work\\demo" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: SHELL_TOOL_USE_ID, content: PT_BR_GET_DATE_OUTPUT }],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: READ_TOOL_USE_ID, name: "read", input: { filePath: "notes.txt" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: READ_TOOL_USE_ID,
          content: READ_OUTPUT,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: ROLLOVER_TEXT },
      ],
    },
  ],
  tools: [
    {
      name: "websearch",
      description: WEBSEARCH_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "read",
      description: READ_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: { filePath: { type: "string" } },
        required: ["filePath"],
      },
    },
    {
      name: "shell",
      description: SHELL_DESCRIPTION,
      input_schema: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
    },
  ],
  stream: true,
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 1024 },
};

/** Fresh deep copy, safe to mutate in a test. */
export function makeWireBody(): WireBody {
  return structuredClone(wireBody);
}

/** Message role used by OpenAI Chat-like APIs, never by Anthropic Messages. */
export type ForeignRole = "system" | "tool" | "developer";

export interface OpenAiChatMessage {
  role: ForeignRole | "user" | "assistant";
  content: string;
  tool_call_id?: string;
}

export interface OpenAiChatBody {
  model: string;
  messages: OpenAiChatMessage[];
  stream: boolean;
}

/**
 * OpenAI Chat-like body (not Anthropic Messages): the system prompt is a
 * role "system" message, so it must be treated as an unknown shape (m7).
 */
export function makeOpenAiChatBody(foreignRole: ForeignRole = "system"): OpenAiChatBody {
  const foreign: OpenAiChatMessage =
    foreignRole === "tool"
      ? { role: "tool", tool_call_id: "call_01", content: PT_BR_GET_DATE_OUTPUT }
      : { role: foreignRole, content: "Today's date: Mon Oct 12 2026" };
  return {
    model: "gpt-5",
    messages: [foreign, { role: "user", content: "Today's date is now: Tue Oct 13 2026" }],
    stream: true,
  };
}
