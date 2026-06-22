import { Box, Text } from "ink";
import { Txt } from "./Txt.tsx";
import { Scrollbar } from "./Scrollbar.tsx";
import { ChatMessage, chatMessageHeight } from "./ChatMessage.tsx";
import type { TranscriptMessage } from "../../types.ts";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Render the chat as a bottom-anchored window. Ink can NOT scroll/clip the TOP of an
// overflow (overflow:hidden only clips bottom/right), so we can't just dump everything and
// rely on flex-end. Instead we measure each block's height and accumulate from the latest
// (minus `offset`) UPWARD, taking only the messages that fit WHOLE. The newest message is
// always pinned to the bottom and fully visible; older history is revealed by scrolling
// (offset). Because every taken message fits, no border or text is ever half-clipped.

export function TranscriptPane({ messages, offset, width, height, spin, color }: { messages: TranscriptMessage[]; offset: number; width: number; height: number; spin: string; color: string }) {
  if (messages.length === 0) {
    return (
      <Box flexGrow={1}>
        <Text dimColor>no transcript yet</Text>
      </Box>
    );
  }
  const avail = Math.max(1, height);
  // How many messages, counting from the OLDEST (msg0) downward, fill the viewport. This caps the
  // scroll: you can't go past "msg0 pinned to the top, screen full" — so the top never opens a gap
  // (the bug: with no cap, the first message ended up alone at the BOTTOM with empty space above).
  let fillFromTop = 0;
  let topUsed = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const h = chatMessageHeight(msg, width);
    if (topUsed + h > avail && fillFromTop > 0) break;
    fillFromTop += 1;
    topUsed += h;
  }
  const maxOffset = Math.max(0, messages.length - fillFromTop);
  const lastIdx = messages.length - 1 - Math.min(Math.max(0, offset), maxOffset);
  const taken: TranscriptMessage[] = [];
  let used = 0;
  for (let i = lastIdx; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const h = chatMessageHeight(msg, width);
    if (used + h > avail && taken.length > 0) break; // stop before a block that won't fit whole
    taken.unshift(msg);
    used += h;
  }
  const reachedTop = taken.length > 0 && taken[0]?.id === messages[0]?.id;
  const startedAt = reachedTop ? (messages.find((m) => m.createdAt)?.createdAt ?? null) : null;
  // topmost visible message index → drives the scrollbar thumb (newest at bottom → offset 0 puts
  // the thumb at the BOTTOM, scrolling up to older history raises it).
  const topIndex = Math.max(0, lastIdx - taken.length + 1);
  return (
    <Box flexDirection="row" flexGrow={1} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} overflow="hidden" justifyContent="flex-end">
        {startedAt ? <Txt dim>{`── chat started · ${fmtDate(startedAt)} ──`}</Txt> : null}
        {taken.map((msg) => (
          <ChatMessage key={msg.id} msg={msg} width={width} spin={spin} />
        ))}
      </Box>
      <Scrollbar total={messages.length} visible={taken.length} offset={topIndex} height={avail} color={color} />
    </Box>
  );
}
