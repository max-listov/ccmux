import stringWidth from "string-width";
import type { AgentKind, SessionState } from "../types.ts";

// Shared TUI primitives — used by BOTH the inline and fullscreen views, so the look
// stays identical and nothing is duplicated.

export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ── display width (terminal columns), not JS string length ────────────────────────────
// Wide glyphs (emoji 🟢, CJK) take 2 columns. Clamping by .length under-counts them, so a
// line that "fits" by char-count overflows the frame's right border. Always measure with
// these for anything rendered inside a bordered/width-constrained box.

export function dispWidth(s: string): number {
  return stringWidth(s);
}

/** Longest prefix of `s` that fits in `max` display columns. */
export function sliceToWidth(s: string, max: number): string {
  if (max <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > max) break;
    w += cw;
    out += ch;
  }
  return out;
}

/** Truncate to `max` display columns, appending an ellipsis when it doesn't fit. */
export function clipWidth(s: string, max: number): string {
  if (stringWidth(s) <= max) return s;
  return `${sliceToWidth(s, Math.max(0, max - 1))}…`;
}

/** Hard word-wrap to `width` display columns — breaks overlong unbreakable tokens (URLs,
 *  paths) so a single token can never spill past the right border. Preserves explicit \n. */
export function wrapText(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    let curW = 0;
    for (const token of para.split(/(\s+)/)) {
      if (token === "") continue;
      const tw = stringWidth(token);
      if (curW + tw <= w) {
        cur += token;
        curW += tw;
        continue;
      }
      if (/^\s+$/.test(token)) {
        lines.push(cur);
        cur = "";
        curW = 0;
        continue;
      }
      if (curW > 0) {
        lines.push(cur);
        cur = "";
        curW = 0;
      }
      let rest = token;
      while (stringWidth(rest) > w) {
        const head = sliceToWidth(rest, w);
        lines.push(head);
        rest = rest.slice(head.length);
      }
      cur = rest;
      curW = stringWidth(rest);
    }
    lines.push(cur);
  }
  return lines;
}

/** Age of a timestamp for display: "now" (<60s), then "5m ago" / "3h ago" / "2d ago".
 *  Minute granularity past the first tier — the label changes at most once a minute, so
 *  memoized cards don't re-render on every poll tick just to repaint the same age. */
export function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** 1_200_000 → "1.2M", 40_000 → "40k", 850 → "850". */
export function fmtTokens(t: number): string {
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`;
  if (t >= 1000) return `${Math.floor(t / 1000)}k`; // truncate (match bash awk %dk), not round
  return String(t);
}

/** Display-layer catch-all: make ANY text safe to render inside a bordered/width-fixed box.
 *  - strip ANSI escapes + control bytes (shell tool output) — they corrupt borders/cursor;
 *  - drop variation selectors + ZWJ and fold emoji to a single-width marker — `string-width`
 *    predicts 2 cols for them but many terminal fonts paint 1, which shifts the right border;
 *  - collapse huge unbroken blobs (base64, hashes, JWTs) so one attachment can't explode the UI.
 *    NOTE: '/' is deliberately EXCLUDED from the blob class — it's a base64 char, but including
 *    it made long file paths ("/Users/…/pane") read as one 56+ run and collapse to "[…].ts".
 *    Paths always contain '/', so excluding it splits them into short, safe segments; real
 *    base64 image data is already neutralized upstream (normalize → "[image]"). */
export function sanitize(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // ANSI CSI sequences
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") // control bytes (keep \t \n)
    .replace(/[︀-️‍]/g, "") // variation selectors + zero-width joiner
    .replace(/\p{Extended_Pictographic}/gu, "•") // fold emoji → safe single-width marker
    .replace(/[A-Za-z0-9+=_-]{56,}/g, "[…]"); // collapse blobs — NOT paths (no '/' in class)
}

/** Provider badge colour: claude=cyan, codex=yellow. */
export function provColor(agent: AgentKind): "cyan" | "yellow" {
  return agent === "codex" ? "yellow" : "cyan";
}

/** Foreground colour for a state label (undefined → terminal default). */
export function stateColor(state: SessionState): "green" | "gray" | "magenta" | undefined {
  if (state === "working") return "green";
  if (state === "stopped") return "gray";
  if (state === "external") return "magenta";
  return undefined;
}

export function dotGlyph(state: SessionState): { glyph: string; color: "green" | "gray" | "magenta" | undefined; dim: boolean } {
  if (state === "working") return { glyph: "●", color: "green", dim: false };
  if (state === "idle") return { glyph: "○", color: "gray", dim: false };
  if (state === "external") return { glyph: "◆", color: "magenta", dim: false };
  return { glyph: "·", color: undefined, dim: true };
}
