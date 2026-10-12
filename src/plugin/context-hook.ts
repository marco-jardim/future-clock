import { shiftRolloverLines, shiftYears } from "../core/years";
import type { ContextEvent, HostPorts } from "./ports";

export interface ContextHookDeps {
  /** Validated year offset (D4). */
  years: number;
  /** Real current year; read once per event. */
  realYear: () => number;
  log: HostPorts["log"];
}

/** One computed string replacement: `apply` writes the new value, `undo` restores the old one. */
interface PendingChange {
  apply: () => void;
  undo: () => void;
}

/**
 * Applies every change or none: if an assignment throws (a frozen object or a
 * throwing setter installed by another plugin), the changes already applied are
 * restored in reverse order and the error is rethrown.
 */
function applyAll(changes: readonly PendingChange[]): void {
  const applied: PendingChange[] = [];
  try {
    for (const change of changes) {
      change.apply();
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) change.undo();
    throw error;
  }
}

/**
 * Context hook (S1–S3, D8, D10): shifts date-shaped years in system parts and
 * tool descriptions, and only the "Today's date is now:" rollover lines of role
 * "system" messages. Messages of every other role are never touched. Mutates in
 * place, only where a change is reported; all-or-nothing; idempotent; never throws.
 */
export function createContextHook(deps: ContextHookDeps): (event: ContextEvent) => void {
  return (event: ContextEvent): void => {
    try {
      const realYear = deps.realYear();
      const shift = (text: string): string | undefined => {
        const result = shiftYears({ text, realYear, years: deps.years, mode: "context" });
        return result.count > 0 ? result.text : undefined;
      };
      const shiftRollover = (text: string): string | undefined => {
        const result = shiftRolloverLines(text, realYear, deps.years);
        return result.count > 0 ? result.text : undefined;
      };

      // Phase 1: compute every new string without touching the event.
      const pending: PendingChange[] = [];

      for (const part of event.system) {
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const previous = part.text;
        const next = shift(previous);
        if (next === undefined) continue;
        pending.push({
          apply: () => {
            part.text = next;
          },
          undo: () => {
            part.text = previous;
          },
        });
      }

      for (const tool of Object.values(event.tools)) {
        if (typeof tool.description !== "string") continue;
        const previous = tool.description;
        const next = shift(previous);
        if (next === undefined) continue;
        pending.push({
          apply: () => {
            tool.description = next;
          },
          undo: () => {
            tool.description = previous;
          },
        });
      }

      for (const message of event.messages) {
        if (message.role !== "system") continue;
        const content = message.content;
        if (typeof content === "string") {
          const next = shiftRollover(content);
          if (next === undefined) continue;
          pending.push({
            apply: () => {
              message.content = next;
            },
            undo: () => {
              message.content = content;
            },
          });
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type !== "text" || typeof item.text !== "string") continue;
            const previous = item.text;
            const next = shiftRollover(previous);
            if (next === undefined) continue;
            pending.push({
              apply: () => {
                item.text = next;
              },
              undo: () => {
                item.text = previous;
              },
            });
          }
        }
      }

      // Phase 2: write them all-or-nothing (rolled back if any assignment throws).
      applyAll(pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log("error", `[future-clock] context hook failed: ${message}`);
    }
  };
}
