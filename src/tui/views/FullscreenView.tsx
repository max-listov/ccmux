import { Box, Text, useStdout } from "ink";
import { VERSION } from "../../util/version.ts";
import { wrapText } from "../format.ts";
import { IS_DEV } from "../../env.ts";
import { SessionCard } from "../components/SessionCard.tsx";
import { TranscriptPane } from "../components/TranscriptPane.tsx";
import { Scrollbar } from "../components/Scrollbar.tsx";
import { Txt } from "../components/Txt.tsx";
import type { FleetItem } from "../fleet.ts";
import type { TranscriptMessage } from "../../types.ts";

type Focus = "list" | "transcript";

/** Fullscreen view — alt-screen app: fleet on the left, scrollable transcript on the
 *  right. The focused pane is outlined cyan (← / → switch); listWidth is resizable. */
export function FullscreenView({
  items,
  externalStart,
  cursor,
  winStart,
  visibleCards,
  spin,
  rcPrefix,
  messages,
  transcriptOffset,
  focus,
  listWidth,
  handleActive,
  hoverPane,
  hoverCard,
  composing,
  composeDraft,
  sending,
  canCompose,
}: {
  items: FleetItem[];
  externalStart: number;
  cursor: number;
  winStart: number;
  visibleCards: number;
  spin: string;
  rcPrefix: string;
  messages: TranscriptMessage[];
  transcriptOffset: number;
  focus: Focus;
  listWidth: number;
  handleActive: boolean;
  hoverPane: Focus | null;
  hoverCard: number | null;
  composing: boolean;
  composeDraft: string;
  sending: boolean;
  canCompose: boolean;
}) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 100;
  const termRows = stdout?.rows ?? 28;
  const sel = items[cursor];
  const externalCount = items.length - externalStart;
  const bodyHeight = Math.max(3, termRows - 2);
  const paneWidth = Math.max(24, cols - listWidth - 5);
  // reserve width for the scrollbar (1 bar + 1 gap) only when the list actually overflows
  const sbReserve = items.length > visibleCards ? 2 : 0;
  // focused → cyan · hovered (not focused) → white · idle → gray
  const paneColor = (pane: Focus): string => (focus === pane ? "cyan" : hoverPane === pane ? "white" : "gray");
  // compose input is ALWAYS visible at the bottom and WRAPS (long text shows whole lines,
  // grows up to 5 rows; beyond that the earliest rows scroll away). The transcript shrinks
  // to make room — its height accounts for the input's current row count.
  const inputW = Math.max(8, paneWidth - 3); // minus the "› " gutter + cursor
  const draftLines = composing && composeDraft.length > 0 ? wrapText(composeDraft, inputW) : [];
  const inputRows = composing ? Math.min(Math.max(draftLines.length, 1), 5) : 1;

  return (
    <Box flexDirection="column" width={cols} height={termRows} overflow="hidden">
      <Box height={1} backgroundColor="cyan" paddingX={1} justifyContent="space-between" flexShrink={0}>
        <Box>
          <Text color="black" bold>{` ccmux v${VERSION} `}</Text>
          {IS_DEV ? <Text color="red" bold>{"DEV "}</Text> : null}
          <Text color="black" bold>{"· fleet "}</Text>
        </Box>
        <Text color="black">{`${rcPrefix} · ${externalStart} managed · ${externalCount} external `}</Text>
      </Box>

      <Box height={bodyHeight} flexShrink={0} overflow="hidden">
        <Box width={listWidth} height={bodyHeight} borderStyle="round" borderColor={paneColor("list")} overflow="hidden">
          <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
            {items.length === 0 ? (
              <Text dimColor>no sessions — n to create</Text>
            ) : (
              items.slice(winStart, winStart + visibleCards).map((it, k, arr) => {
                const i = winStart + k; // global index (slice is the scroll window)
                const isLast = k === arr.length - 1;
                return (
                  <Box key={it.row.session.uuid} flexDirection="column" flexShrink={0} marginBottom={isLast ? 0 : 1}>
                    {i === externalStart ? (
                      <Text color="magenta" dimColor>── external · live outside ccmux (read-only) ──</Text>
                    ) : null}
                    <SessionCard item={it} selected={i === cursor} hovered={i === hoverCard} spin={spin} showDir framed cardWidth={Math.max(20, listWidth - 4 - sbReserve)} lastWidth={Math.max(14, listWidth - 12 - sbReserve)} />
                  </Box>
                );
              })
            )}
          </Box>
          <Scrollbar total={items.length} visible={visibleCards} offset={winStart} height={Math.max(1, bodyHeight - 2)} color={paneColor("list")} />
        </Box>
        {/* divider between two separate blocks — INVISIBLE by default, appears as a thin
            muted line only on hover/drag. Spans the CONTENT height (inset past the block
            borders), not the full frame. This is the resize handle. */}
        <Box flexDirection="column" marginTop={1}>
          {Array.from({ length: Math.max(1, bodyHeight - 2) }).map((_, i) => (
            <Txt key={i} color={handleActive ? "cyan" : undefined} dim={handleActive}>
              {handleActive ? "│" : " "}
            </Txt>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1} height={bodyHeight} borderStyle="round" borderColor={paneColor("transcript")} paddingX={1} overflow="hidden">
          <Text>
            <Text bold color={sel?.external ? "magenta" : "cyan"}>{sel?.row.session.name ?? "—"}</Text>
            <Text dimColor> · {sel?.external ? "external · read-only" : "transcript"}{transcriptOffset > 0 ? ` (↑${transcriptOffset})` : ""}</Text>
          </Text>
          <Box height={1} flexShrink={0} />
          <TranscriptPane messages={messages} offset={transcriptOffset} width={Math.max(8, paneWidth - 2)} height={Math.max(1, bodyHeight - 4 - inputRows)} spin={spin} color={paneColor("transcript")} />
          {/* compose input — pinned at the bottom, ALWAYS visible; wraps whole lines while
              composing (no mid-word truncation), growing up to 5 rows */}
          <Box height={inputRows} flexShrink={0} flexDirection="column" overflow="hidden">
            {composing ? (
              draftLines.length === 0 ? (
                <Box>
                  <Txt color="green" bold>{"› "}</Txt>
                  <Txt dim italic>{"type a message — Enter to send · Esc to cancel"}</Txt>
                </Box>
              ) : (
                draftLines.slice(-5).map((ln, i, arr) => (
                  <Box key={i}>
                    <Txt color="green" bold>{i === 0 ? "› " : "  "}</Txt>
                    <Text>{ln}</Text>
                    {i === arr.length - 1 ? <Txt color="green">{"▏"}</Txt> : null}
                  </Box>
                ))
              )
            ) : sending ? (
              <Txt color="green">{"  sending…"}</Txt>
            ) : canCompose ? (
              <Txt dim>{"› press i to send a message"}</Txt>
            ) : (
              <Txt dim>{"  read-only · external session"}</Txt>
            )}
          </Box>
        </Box>
      </Box>

      <Box height={1} backgroundColor="gray" paddingX={1} flexShrink={0}>
        <Text color="black">{composing
          ? ` compose — ↵ send   esc cancel `
          : sel?.external
            ? ` ←→ pane   ↑↓ session   a adopt   [ ] resize   f inline   q quit `
            : ` ←→ pane   ↑↓ ${focus === "transcript" ? "scroll" : "session"}   i message   [ ] resize   ↵ attach   f inline   q quit `}</Text>
      </Box>
    </Box>
  );
}
