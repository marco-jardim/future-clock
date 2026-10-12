export type Mode = "context" | "clock";
export interface ShiftInput { text: string; realYear: number; years: number; mode: Mode; }
export interface ShiftResult { text: string; count: number; }
export interface ClockClassification { isClockRead: boolean; matched: readonly string[]; }
