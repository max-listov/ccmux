// Single source of truth for "what is this tool and how do we show it". The category
// regexes used to live duplicated in status.ts AND ChatMessage.tsx; everything that needs
// a tool's icon/color/verb now reads it from here (status, transcript card, card preview).

export type ToolCategory = "read" | "edit" | "write" | "run" | "search" | "agent" | "ask" | "mcp" | "tool";

const EDIT = /^(Edit|MultiEdit|NotebookEdit|apply_patch|patch|str_replace)/i;
const WRITE = /^(Write|create_file)/i;
const RUN = /^(Bash|exec_command|local_shell|shell|run|exec)/i;
const SEARCH = /^(ToolSearch|WebSearch|WebFetch|web_search)|_search$/i;
const AGENT = /^(Agent|Task|run_agent|run_swarm)/i;
const ASK = /^AskUserQuestion/i;
const READ = /^(Read|Grep|Glob|LS|NotebookRead|grep|find|list)/i;

/** Classify a raw tool name into one display category. Order matters: the more specific
 *  buckets (ask/agent/write/edit) are tested before the broad read/run/search ones. */
export function toolCategory(name: string): ToolCategory {
  if (name.startsWith("mcp__")) return "mcp";
  if (ASK.test(name)) return "ask";
  if (AGENT.test(name)) return "agent";
  if (WRITE.test(name)) return "write";
  if (EDIT.test(name)) return "edit";
  if (RUN.test(name)) return "run";
  if (SEARCH.test(name)) return "search";
  if (READ.test(name)) return "read";
  return "tool";
}

export interface ToolMeta {
  category: ToolCategory;
  icon: string; // single display-width glyph
  color: string; // ink color for the chip when active/pending
  doing: string; // present-tense label while the call is in flight ("Editing")
  done: string; // past-tense label once a result arrived ("Edited")
}

const TABLE: Record<ToolCategory, Omit<ToolMeta, "category">> = {
  read: { icon: "◉", color: "blue", doing: "Reading", done: "Read" },
  edit: { icon: "✎", color: "yellow", doing: "Editing", done: "Edited" },
  write: { icon: "✚", color: "yellow", doing: "Writing", done: "Wrote" },
  run: { icon: "▸", color: "cyan", doing: "Running", done: "Ran" },
  search: { icon: "⌕", color: "blue", doing: "Searching", done: "Searched" },
  agent: { icon: "◆", color: "magenta", doing: "Running", done: "Ran" },
  ask: { icon: "?", color: "green", doing: "Asking", done: "Asked" },
  mcp: { icon: "⚙", color: "cyan", doing: "Calling", done: "Called" },
  tool: { icon: "✱", color: "cyan", doing: "Running", done: "Ran" },
};

export function toolMeta(name: string): ToolMeta {
  const category = toolCategory(name);
  return { category, ...TABLE[category] };
}

/** Human label for a tool name: strip the `mcp__server__` prefix, tidy a couple of known
 *  verbose names. Used wherever the actual tool identity (not its category) should show. */
export function toolDisplayName(name: string): string {
  if (name === "AskUserQuestion") return "Ask";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__").filter(Boolean);
    return parts[parts.length - 1] ?? name;
  }
  return name;
}

// Categories whose action reads better as a tense-inflected verb ("Reading"/"Read") than as
// the raw tool name. The rest (agent/ask/mcp/tool) keep their identity name.
const VERB_CATEGORIES = new Set<ToolCategory>(["read", "edit", "write", "run", "search"]);

/** The label shown on a tool card's top line, given its live state. */
export function toolLabel(name: string, pending: boolean): string {
  const meta = toolMeta(name);
  if (VERB_CATEGORIES.has(meta.category)) return pending ? meta.doing : meta.done;
  return toolDisplayName(name);
}
