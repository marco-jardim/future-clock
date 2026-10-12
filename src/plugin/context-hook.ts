import { shiftYears } from "../core/years";
import type { ContextEvent, HostPorts } from "./ports";

export interface ContextHookDeps {
  /** Validated year offset (D4). */
  years: number;
  /** Real current year; read once per event. */
  realYear: () => number;
  log: HostPorts["log"];
}

/**
 * Context hook (S1–S3, D8, D10): shifts date-shaped years in system parts,
 * tool descriptions and role "system" messages (e.g. the day rollover notice).
 * Messages of every other role are never touched. Mutates in place, only where
 * `shiftYears` reports a change; idempotent; never throws.
 */
export function createContextHook(deps: ContextHookDeps): (event: ContextEvent) => void {
  return (event: ContextEvent): void => {
    try {
      const realYear = deps.realYear();
      const shift = (text: string): string | undefined => {
        const result = shiftYears({ text, realYear, years: deps.years, mode: "context" });
        return result.count > 0 ? result.text : undefined;
      };

      // Compute every change first, apply afterwards: a failure mid-way leaves the event as is.
      const pending: Array<() => void> = [];

      for (const part of event.system) {
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const next = shift(part.text);
        if (next !== undefined) pending.push(() => (part.text = next));
      }

      for (const tool of Object.values(event.tools)) {
        if (typeof tool.description !== "string") continue;
        const next = shift(tool.description);
        if (next !== undefined) pending.push(() => (tool.description = next));
      }

      for (const message of event.messages) {
        if (message.role !== "system") continue;
        const content = message.content;
        if (typeof content === "string") {
          const next = shift(content);
          if (next !== undefined) pending.push(() => (message.content = next));
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type !== "text" || typeof item.text !== "string") continue;
            const next = shift(item.text);
            if (next !== undefined) pending.push(() => (item.text = next));
          }
        }
      }

      for (const apply of pending) apply();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log("error", `[future-clock] context hook failed: ${message}`);
    }
  };
}
