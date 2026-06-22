import { memo } from "react";
import { Box } from "ink";
import { Txt } from "./Txt.tsx";
import { Markdown } from "./Markdown.tsx";
import { sanitize, dispWidth, clipWidth, wrapText } from "../format.ts";
import { toolCardView } from "../toolCard.ts";
import { DiffStat, isDiffStat } from "./DiffStat.tsx";
import type { TranscriptMessage } from "../../types.ts";

// One chat block — the reusable unit of the transcript render. Text turns (user/assistant)
// are shown in FULL (wrapped, never truncated); a tool call is a compact TWO-ROW card (request
// on top, outcome below); thinking collapses to a marker. Agent-agnostic.

/** Collapse to one line, clamped by DISPLAY width (so wide glyphs don't overflow). */
function oneLine(s: string, w: number): string {
  return clipWidth(s.replace(/\s+/g, " ").trim(), Math.max(4, w));
}

/** Cap length but KEEP newlines — so code/lists/tables in a text turn stay structured. */
function clampKeepLines(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Wrapped body lines for a text turn — shared by the renderer and the height calc so they
 *  never drift. USER body is narrower (box border + padding); ASSISTANT loses the bar+gap. */
function textWrapped(text: string, width: number, isUser: boolean): string[] {
  const body = Math.max(4, width - (isUser ? 4 : 2));
  return wrapText(clampKeepLines(text, width * 40), body);
}

function computeHeight(msg: TranscriptMessage, width: number): number {
  if (msg.kind === "tool_call") return 2; // request row + outcome row
  if (msg.kind === "tool_result" || msg.kind === "thinking") return 1;
  const text = sanitize((msg.text ?? "").trim());
  const isUser = msg.role === "user";
  const lines = Math.max(1, textWrapped(text, width, isUser).length);
  return isUser ? lines + 4 : lines + 1; // user: marginTop + 2 borders + label; assistant: marginTop
}

// Messages are immutable (re-parsed only when the jsonl changes → a NEW object), so height at a
// given width is stable. Cache it per (msg, width) to keep the sanitize+wrap cost out of the
// transcript's measure loops (which run on every spinner tick / fleet poll). WeakMap → no leak.
const heightCache = new WeakMap<TranscriptMessage, Map<number, number>>();

/** Rendered ROW COUNT of a message at `width`. The transcript uses this to pick exactly the
 *  messages that fit from the bottom up — Ink can't clip the TOP of an overflow, so we never
 *  render a message (or a box border) that wouldn't fit whole. Mirrors the layout below. */
export function chatMessageHeight(msg: TranscriptMessage, width: number): number {
  let byWidth = heightCache.get(msg);
  if (!byWidth) {
    byWidth = new Map();
    heightCache.set(msg, byWidth);
  }
  const hit = byWidth.get(width);
  if (hit !== undefined) return hit;
  const h = computeHeight(msg, width);
  byWidth.set(width, h);
  return h;
}

function ChatMessageImpl({ msg, width, spin }: { msg: TranscriptMessage; width: number; spin: string }) {
  const text = sanitize((msg.text ?? "").trim());

  if (msg.kind === "tool_call") {
    const v = toolCardView(msg, spin);
    const label = `${v.glyph} ${v.label}`;
    const reqW = width - dispWidth(label) - 2;
    return (
      <Box flexDirection="column">
        <Box>
          <Txt color={v.topColor} bold>{label}</Txt>
          <Txt dim>{`  ${oneLine(sanitize(v.request), reqW)}`}</Txt>
        </Box>
        <Box>
          <Txt dim={!v.resultColor} color={v.resultColor}>{"  ↳ "}</Txt>
          {isDiffStat(v.result) ? (
            <DiffStat result={v.result} />
          ) : (
            <Txt dim={!v.resultColor} color={v.resultColor}>{oneLine(sanitize(v.result), width - 5)}</Txt>
          )}
        </Box>
      </Box>
    );
  }
  if (msg.kind === "tool_result") {
    // A result whose call fell outside the window (unfolded) — keep the faint one-liner.
    return (
      <Box>
        <Txt dim>{`  ↳ ${oneLine(text, width - 5)}`}</Txt>
      </Box>
    );
  }
  if (msg.kind === "thinking") {
    return (
      <Box>
        <Txt dim italic>· thinking</Txt>
      </Box>
    );
  }

  // text turn — full, hard-wrapped to the pane width (long paths/URLs can't spill past the
  // border). USER turns are FRAMED in a green box (the conversation's anchors); ASSISTANT
  // turns flow with a thin cyan quote-bar. Each wrapped line is its own row.
  const isUser = msg.role === "user";

  if (isUser) {
    const wrapped = textWrapped(text, width, true);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box width={width} flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Txt color="green" bold>you</Txt>
          {wrapped.map((ln, i) => (
            <Box key={i}>
              <Markdown text={ln} baseDim={false} />
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  const wrapped = textWrapped(text, width, false);
  return (
    <Box marginTop={1}>
      <Box flexDirection="column" flexShrink={0} marginRight={1}>
        {wrapped.map((_, i) => (
          <Txt key={i} color="cyan">{"▌"}</Txt>
        ))}
      </Box>
      <Box flexDirection="column">
        {wrapped.map((ln, i) => (
          <Box key={i}>
            <Markdown text={ln} baseDim={false} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** Memo by message IDENTITY: a spinner tick or fleet poll re-renders App but does NOT rebuild the
 *  messages array, so every historical message skips re-render (and its markdown re-parse). `spin`
 *  is compared ONLY for tool_call rows (the one with the animated glyph); text/thinking/result rows
 *  ignore it. This keeps the transcript out of the hot render path even while an agent is working. */
export const ChatMessage = memo(ChatMessageImpl, (a, b) =>
  a.msg === b.msg && a.width === b.width && (a.msg.kind === "tool_call" ? a.spin === b.spin : true),
);
