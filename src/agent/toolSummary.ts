import { toolCategory } from "./toolMeta.ts";
import { rec, str } from "./normalize.ts";

// Build the ONE-LINE "what came out of it" string shown on the bottom row of a tool card.
// Always computed from the RAW input/result (never the display-clipped message text), so the
// counts are truthful regardless of how the UI later truncates. Pure: data → short label.

/** Non-empty trimmed line count of a blob. "" → 0. */
export function countLines(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split("\n").length;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Lines added/removed for an Edit-family call, read from its INPUT (old/new string). For a
 *  MultiEdit the per-edit blocks are summed. A replacement counts the whole block on each side
 *  — a rough but honest "+N −M" that matches what the diff touched. */
function editDiff(input: Record<string, unknown> | null): { added: number; removed: number } {
  if (!input) return { added: 0, removed: 0 };
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  let added = 0;
  let removed = 0;
  for (const eRaw of edits) {
    const e = rec(eRaw);
    if (!e) continue;
    const oldS = str(e.old_string);
    const newS = str(e.new_string) ?? str(input.content); // Write has no old, content is the new
    if (newS !== null) added += countLines(newS);
    if (oldS !== null) removed += countLines(oldS);
  }
  return { added, removed };
}

/** First meaningful line of a result, clipped — the fallback summary for tools we don't model.
 *  Structured (JSON-looking) output has no readable first line, so it degrades to a line count. */
function firstLine(s: string, max = 48): string {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (line.startsWith("{") || line.startsWith("[")) return plural(countLines(s), "line");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Short result label for a finished tool call.
 *   edit  → "+12 −3"      write → "wrote 40 lines"
 *   read  → "248 lines"   run   → "6 lines" / "ok"
 *   grep  → "3 matches"   else  → first line of output / "done"
 * `isError` short-circuits to the error's first line.
 */
export function resultSummary(name: string, input: Record<string, unknown> | null, resultText: string, isError: boolean): string {
  if (isError) return firstLine(resultText) || "error";
  const cat = toolCategory(name);
  switch (cat) {
    case "edit": {
      const { added, removed } = editDiff(input);
      return `+${added} −${removed}`;
    }
    case "write": {
      const n = countLines(str(input?.content) ?? "");
      return `wrote ${plural(n, "line")}`;
    }
    case "read":
      return plural(countLines(resultText), "line");
    case "run": {
      const n = countLines(resultText);
      return n === 0 ? "ok" : plural(n, "line");
    }
    case "search":
      return plural(countLines(resultText), "result");
    default:
      return firstLine(resultText) || "done";
  }
}
