import { memo, type ReactNode } from "react";
import { Text } from "ink";
import { Txt } from "./Txt.tsx";
import { dispWidth, sliceToWidth } from "../format.ts";

// Inline markdown → Ink Text segments. Single-line (transcript/last rows are flattened),
// so no block parsing — just **bold**, `code`, *italic* / _italic_. Unmatched markup
// passes through verbatim. Base text is dim; styled spans stand out.

interface Seg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function parseInline(input: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of input.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ text: input.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith("**")) segs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) segs.push({ text: tok.slice(1, -1), code: true });
    else segs.push({ text: tok.slice(1, -1), italic: true });
    last = idx + tok.length;
  }
  if (last < input.length) segs.push({ text: input.slice(last) });
  return segs;
}

/** Clamp parsed segments to a visible width (DISPLAY columns, not char count, so wide
 *  glyphs don't overflow), adding an ellipsis — applied AFTER parsing so a markdown token
 *  is never cut in half (no dangling ** or `). */
function clampSegs(segs: Seg[], max: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= max) return out;
    const room = max - used;
    const w = dispWidth(s.text);
    if (w <= room) {
      out.push(s);
      used += w;
    } else {
      out.push({ ...s, text: `${sliceToWidth(s.text, Math.max(0, room - 1))}…` });
      return out;
    }
  }
  return out;
}

/** Render inline markdown as styled spans.
 *  - `maxWidth`: truncate to one line by VISIBLE length with an ellipsis (never mid-token).
 *  - `wrap`: wrap the spans inside ONE <Text wrap="wrap"> so a multi-line paragraph wraps
 *    correctly. WITHOUT this, an array of spans in a <Box> flows horizontally and overlaps
 *    on line breaks — the cause of the "text spills past the frame" garbling. */
// memo'd: props are all primitives, so a parent re-render (spinner tick, fleet poll) won't
// re-run the inline parse when the text/width are unchanged — keeps markdown out of the hot path.
export const Markdown = memo(function Markdown({ text, baseDim = true, maxWidth, wrap = false, clip = false }: { text: string; baseDim?: boolean; maxWidth?: number; wrap?: boolean; clip?: boolean }): ReactNode {
  const segs = maxWidth !== undefined ? clampSegs(parseInline(text), maxWidth) : parseInline(text);
  const nodes = segs.map((s, i) => {
    if (s.code) return <Txt key={i} color="yellow">{s.text}</Txt>;
    if (s.bold) return <Txt key={i} bold>{s.text}</Txt>;
    if (s.italic) return <Txt key={i} italic dim={baseDim}>{s.text}</Txt>;
    return <Txt key={i} dim={baseDim}>{s.text}</Txt>;
  });
  // clip → truncate to the parent box width (display-aware, via Ink); wrap → soft-wrap.
  if (clip) return <Text wrap="truncate">{nodes}</Text>;
  return wrap ? <Text wrap="wrap">{nodes}</Text> : nodes;
});
