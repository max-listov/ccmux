import { memo } from "react";
import { Box } from "ink";
import { SessionRow } from "./SessionRow.tsx";
import { Markdown } from "./Markdown.tsx";
import { Txt } from "./Txt.tsx";
import { sanitize, provColor, wrapText, clipWidth, dispWidth } from "../format.ts";
import { statusMark } from "../status.ts";
import { toolCardView } from "../toolCard.ts";
import { DiffStat, isDiffStat } from "./DiffStat.tsx";
import type { FleetItem } from "../fleet.ts";

/** Show the tail of a path when it's too long (the meaningful end). */
function tailPath(p: string, max: number): string {
  return p.length > max ? `…${p.slice(-(max - 1))}` : p;
}

/** Greedy word-wrap to at most `maxLines` lines of `width` DISPLAY columns, ellipsis on
 *  overflow. The fixed-width clip box in the card is the safety net; this picks the breaks. */
function wrapLines(text: string, width: number, maxLines: number): string[] {
  const all = wrapText(text, width);
  if (all.length <= maxLines) return all;
  const out = all.slice(0, maxLines);
  const lastLine = out[out.length - 1] ?? "";
  out[out.length - 1] = clipWidth(`${lastLine} …`, width);
  return out;
}

/**
 * A session card.
 * `framed` (fullscreen list): a structured card —
 *   ╭─ name ╎ status ──────╮   header: name + status badge
 *   │ /path/to/dir         │   location
 *   │ claude · model · ctx · up │   technical info
 *   │ ──────────────────── │   divider
 *   │ └ last action…       │   last action (2 lines)
 *   ╰──────────────────────╯
 * otherwise (inline stream): a left cyan accent bar + the same data.
 */
function SessionCardImpl({
  item,
  selected,
  hovered = false,
  spin,
  showDir,
  lastWidth,
  framed = false,
  cardWidth = 40,
}: { item: FleetItem; selected: boolean; hovered?: boolean; spin: string; showDir: boolean; lastWidth: number; framed?: boolean; cardWidth?: number }) {
  const { row, status, external } = item;
  const s = row.session;
  const lm = row.lastMessage;
  const empty = !lm?.text?.trim();
  const last = sanitize((lm?.text ?? "—").replace(/\s+/g, " ").trim());
  // When the last activity is a tool call, the preview becomes a two-row tool card (request /
  // outcome) instead of dumping the raw tool output text.
  const tool = lm?.kind === "tool_call" ? toolCardView(lm, spin) : null;

  if (framed) {
    const bc = selected ? "cyan" : hovered ? "white" : "gray";
    const dim = !selected;
    const innerW = cardWidth - 2; // chars between the two corners
    const textW = Math.max(8, cardWidth - 4); // usable text width inside │ … │
    // header sewn into the top border: ╭─ name ─── ◔ status ─────╮ — measured by DISPLAY
    // width (not .length) and the name clipped, so the top ╮ corner aligns with the body │.
    const badge = `${statusMark(status, spin)} ${status.label}`;
    const name = clipWidth(s.name, Math.max(3, cardWidth - 12 - dispWidth(badge)));
    const trail = "─".repeat(Math.max(0, cardWidth - 10 - dispWidth(name) - dispWidth(badge)));
    // preview: up to TWO wrapped lines (always renders 2 rows → stable card height)
    const lines = wrapLines(last, Math.max(8, lastWidth), 2);
    // Fully manual frame — the only way to get a divider that truly CONNECTS to the side
    // borders (├──┤) edge-to-edge. A flexGrow spacer pushes the right │ to the edge, so
    // styled/variable-width content needs no width math.
    return (
      <Box flexDirection="column" flexShrink={0} width={cardWidth}>
        <Box>
          <Txt color={bc}>{"╭─ "}</Txt>
          <Txt color={external ? "magenta" : undefined} bold>{name}</Txt>
          <Txt color={bc}>{" ─── "}</Txt>
          <Txt color={status.color} bold={status.active}>{badge}</Txt>
          <Txt color={bc}>{` ${trail}╮`}</Txt>
        </Box>
        <Box>
          <Txt color={bc}>{"│ "}</Txt>
          <Txt dim>{tailPath(s.dir, textW)}</Txt>
          <Box flexGrow={1} />
          <Txt color={bc}>{"│"}</Txt>
        </Box>
        <Box>
          <Txt color={bc}>{"│ "}</Txt>
          <Txt color={provColor(s.agent)}>{s.agent}</Txt>
          <Txt dim>{" · "}</Txt>
          <Txt>{row.model ?? "—"}</Txt>
          <Txt dim>{` · ${row.contextLabel} · ${row.uptimeText}`}</Txt>
          <Box flexGrow={1} />
          <Txt color={bc}>{"│"}</Txt>
        </Box>
        {/* divider — connected to the side borders, full width */}
        <Txt color={bc}>{`├${"─".repeat(innerW)}┤`}</Txt>
        {empty ? (
          <>
            <Box>
              <Txt color={bc}>{"│"}</Txt>
              <Box flexGrow={1} justifyContent="center">
                <Txt dim italic>{"no messages yet"}</Txt>
              </Box>
              <Txt color={bc}>{"│"}</Txt>
            </Box>
            <Box>
              <Txt color={bc}>{"│"}</Txt>
              <Box flexGrow={1} />
              <Txt color={bc}>{"│"}</Txt>
            </Box>
          </>
        ) : tool ? (
          <>
            <Box>
              <Txt color={bc}>{"│ "}</Txt>
              <Txt color={selected ? "cyan" : undefined} dim={dim}>{"└ "}</Txt>
              <Txt color={tool.topColor} bold={!dim}>{`${tool.glyph} ${tool.label} `}</Txt>
              <Box width={Math.max(4, lastWidth - dispWidth(`${tool.glyph} ${tool.label} `))} flexShrink={0} overflow="hidden">
                <Txt dim>{clipWidth(sanitize(tool.request), Math.max(4, lastWidth - dispWidth(`${tool.glyph} ${tool.label} `)))}</Txt>
              </Box>
              <Box flexGrow={1} />
              <Txt color={bc}>{"│"}</Txt>
            </Box>
            <Box>
              <Txt color={bc}>{"│   "}</Txt>
              <Txt dim>{"↳ "}</Txt>
              <Box width={Math.max(4, lastWidth - 2)} flexShrink={0} overflow="hidden">
                {isDiffStat(tool.result) ? (
                  <DiffStat result={tool.result} />
                ) : (
                  <Txt color={tool.resultColor} dim={!tool.resultColor}>{clipWidth(sanitize(tool.result), Math.max(4, lastWidth - 2))}</Txt>
                )}
              </Box>
              <Box flexGrow={1} />
              <Txt color={bc}>{"│"}</Txt>
            </Box>
          </>
        ) : (
          <>
            <Box>
              <Txt color={bc}>{"│ "}</Txt>
              <Txt color={selected ? "cyan" : undefined} dim={dim}>{"└ "}</Txt>
              <Box width={lastWidth} flexShrink={0} overflow="hidden">
                <Markdown text={lines[0] ?? "—"} clip baseDim={dim} />
              </Box>
              <Box flexGrow={1} />
              <Txt color={bc}>{"│"}</Txt>
            </Box>
            <Box>
              <Txt color={bc}>{"│   "}</Txt>
              <Box width={lastWidth} flexShrink={0} overflow="hidden">
                <Markdown text={lines[1] ?? ""} clip baseDim={dim} />
              </Box>
              <Box flexGrow={1} />
              <Txt color={bc}>{"│"}</Txt>
            </Box>
          </>
        )}
        <Txt color={bc}>{`╰${"─".repeat(innerW)}╯`}</Txt>
      </Box>
    );
  }

  const bar = selected ? "▌" : " ";
  return (
    <Box marginBottom={1}>
      <Box flexDirection="column">
        <Txt color="cyan">{bar}</Txt>
        <Txt color="cyan">{bar}</Txt>
        {showDir ? <Txt color="cyan">{bar}</Txt> : null}
      </Box>
      <Box flexDirection="column">
        <SessionRow item={item} selected={selected} spin={spin} />
        <Box paddingLeft={2}>
          <Txt color={selected ? "cyan" : undefined} dim={!selected}>{"└ "}</Txt>
          {tool ? (
            <>
              <Txt color={tool.topColor} bold>{`${tool.glyph} ${tool.label} `}</Txt>
              <Txt dim>{clipWidth(sanitize(`${tool.request} · ${tool.result}`), Math.max(8, lastWidth))}</Txt>
            </>
          ) : (
            <Markdown text={last} maxWidth={lastWidth} baseDim={!selected} />
          )}
        </Box>
        {showDir ? (
          <Box paddingLeft={2}>
            <Txt dim>{`  ${s.dir}`}</Txt>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

/** Memo: a card's cost is sanitize/wrap/markdown on the last message + the status badge. buildItems
 *  makes a FRESH FleetItem every fleet poll (1.5s), so without this every card re-renders 0.7×/s for
 *  nothing. We bail when the RENDERED inputs are unchanged — `lastMessage` is a stable ref (mtime
 *  cache in agent/discover), the rest are primitives. `spin` matters only for an actively-animating
 *  card (`status.active` ⟺ a pending tool/working badge). */
export const SessionCard = memo(SessionCardImpl, (a, b) => {
  if (a.selected !== b.selected || a.hovered !== b.hovered || a.showDir !== b.showDir || a.framed !== b.framed || a.cardWidth !== b.cardWidth || a.lastWidth !== b.lastWidth) return false;
  const x = a.item;
  const y = b.item;
  if (x.external !== y.external || x.row.lastMessage !== y.row.lastMessage) return false;
  if (x.row.model !== y.row.model || x.row.contextLabel !== y.row.contextLabel || x.row.uptimeText !== y.row.uptimeText) return false;
  if (x.row.session.name !== y.row.session.name || x.row.session.dir !== y.row.session.dir || x.row.session.agent !== y.row.session.agent) return false;
  const ps = x.status;
  const qs = y.status;
  if (ps.key !== qs.key || ps.label !== qs.label || ps.color !== qs.color || ps.icon !== qs.icon || ps.active !== qs.active) return false;
  if (ps.active && a.spin !== b.spin) return false;
  return true;
});
