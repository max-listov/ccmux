import { toolMeta, toolLabel } from "../agent/toolMeta.ts";
import type { TranscriptMessage } from "../types.ts";

// Pure view-model for a tool call rendered as a two-row card. The LAYOUT differs per site (the
// fleet card draws inside its manual frame, the transcript draws full-width), so this returns
// just the pieces + colors and each site arranges them. Three states, driven by the folded
// result data (not the pane): pending → spinner + present verb; ok → icon + past verb, green
// outcome; error → icon + red.

export interface ToolCardView {
  glyph: string; // leading mark: the spinner while pending, the category icon once done
  label: string; // "Editing" / "Edited" / "firecrawl_search"
  topColor: string; // color of glyph+label (category while pending, green ok, red error)
  request: string; // top row: what was asked (file / command / pattern / query)
  result: string; // bottom row: the outcome ("+12 −3", "248 lines", "running…")
  resultColor: string | undefined; // red on error, else undefined (dim)
  error: boolean;
}

export function toolCardView(msg: TranscriptMessage, spin: string): ToolCardView {
  const name = msg.toolName ?? "tool";
  const meta = toolMeta(name);
  const error = msg.status === "error";
  const pending = !msg.done && !error;
  return {
    glyph: pending ? spin : meta.icon,
    label: toolLabel(name, pending),
    topColor: error ? "red" : pending ? meta.color : "green",
    request: msg.text ?? "",
    result: pending ? "running…" : (msg.result ?? (error ? "error" : "done")),
    resultColor: error ? "red" : undefined,
    error,
  };
}
