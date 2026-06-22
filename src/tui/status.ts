import type { TranscriptMessage } from "../types.ts";
import { toolCategory, toolDisplayName } from "../agent/toolMeta.ts";

// Unified, agent-agnostic activity status — derived from the last transcript message +
// whether the agent is actively working. Same vocabulary for Claude, Codex and any
// future provider, so the fleet reads consistently. This is the foundation the upcoming
// agent-command features build on.

export type StatusKey = "thinking" | "writing" | "reading" | "editing" | "running" | "tool" | "waiting" | "idle" | "stopped";

export interface AgentStatus {
  key: StatusKey;
  label: string;
  color: string;
  icon: string; // distinct per-status glyph (single-width)
  active: boolean; // true → also show a spinner (the agent is doing something right now)
}

const ICON: Record<StatusKey, string> = {
  thinking: "✦",
  writing: "✎",
  reading: "◉",
  editing: "✐",
  running: "▸",
  tool: "✱",
  waiting: "◔",
  idle: "○",
  stopped: "▪",
};

function st(key: StatusKey, label: string, color: string, active: boolean): AgentStatus {
  return { key, label, color, icon: ICON[key], active };
}

function fromTool(name: string): AgentStatus {
  const cat = toolCategory(name);
  if (cat === "read" || cat === "search") return st("reading", "reading", "blue", true);
  if (cat === "edit" || cat === "write") return st("editing", "editing", "yellow", true);
  if (cat === "run") return st("running", "running", "cyan", true);
  return st("tool", toolDisplayName(name) || "tool", "cyan", true);
}

function working(lm: TranscriptMessage | null): AgentStatus {
  if (!lm) return st("running", "working", "green", true);
  if (lm.kind === "thinking") return st("thinking", "thinking", "magenta", true);
  if (lm.kind === "tool_call") return fromTool(lm.toolName ?? "");
  if (lm.kind === "tool_result") return st("running", "running", "cyan", true);
  if (lm.role === "assistant") return st("writing", "writing", "green", true);
  return st("thinking", "thinking", "magenta", true); // user just spoke → agent will respond
}

/** Derive the unified status. `isWorking` = agent active right now (pane spinner for
 *  managed, recent file activity for external). */
export function deriveStatus(opts: { running: boolean; isWorking: boolean; lastMessage: TranscriptMessage | null }): AgentStatus {
  if (!opts.running) return st("stopped", "stopped", "gray", false);
  if (opts.isWorking) return working(opts.lastMessage);
  // not actively working → waiting for our input if the assistant finished its turn, else idle
  const lm = opts.lastMessage;
  if (lm && lm.role === "assistant" && lm.kind === "message") return st("waiting", "waiting", "yellow", false);
  return st("idle", "idle", "gray", false);
}

/** Display mark: per-status icon, prefixed with the spinner when the agent is active. */
export function statusMark(status: AgentStatus, spin: string): string {
  return status.active ? `${spin} ${status.icon}` : status.icon;
}
