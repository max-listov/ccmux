// Shared primitives for reading UNTYPED external transcript JSON (Claude / Codex own
// their shapes). Every field is reached through type-guards — no `as`, no casts.

export const DEFAULT_TEXT_LIMIT = 6000;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function rec(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

/** One content block → readable text. Images and unknown structured blocks become short
 *  markers ([image] / [type]) — NEVER raw JSON, so a base64 image can't leak into the UI. */
function blockText(b: unknown): string {
  if (typeof b === "string") return b;
  const r = rec(b);
  if (!r) return "";
  const t = str(r.type) ?? "";
  if (t === "text" || t === "input_text" || t === "output_text") return str(r.text) ?? "";
  if (t === "image" || t === "input_image" || t === "image_url" || t === "tool_use_image") return "[image]";
  const direct = str(r.text) ?? str(r.content);
  if (direct) return direct;
  if (Array.isArray(r.content)) {
    const inner = r.content.map(blockText).filter((s) => s !== "");
    if (inner.length > 0) return inner.join(" ");
  }
  return t ? `[${t}]` : "";
}

/** Flatten structured content (arrays of blocks, image payloads, tool output) to display
 *  text. Structured data degrades to markers, never `JSON.stringify` — the fix for raw
 *  `[{"type":"image","source":{"base64"…}}]` leaking into a card preview. */
export function flattenContent(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map(blockText).filter((s) => s !== "");
    return parts.length > 0 ? parts.join(" ") : null;
  }
  if (isRecord(v)) return blockText(v) || null;
  return String(v);
}

/** Back-compat alias — same flatten-to-markers behaviour (no raw JSON). */
export function asText(v: unknown): string | null {
  return flattenContent(v);
}

export function clip(s: string, limit: number): string {
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
