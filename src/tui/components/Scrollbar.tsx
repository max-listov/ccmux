import { Box, Text } from "ink";

/** A slim custom vertical scrollbar for the windowed list. The thumb height is proportional
 *  to the visible fraction and its position to how far the window is scrolled; it glows in the
 *  pane's accent colour (cyan when focused) over a dim track — matching ccmux's round-border
 *  aesthetic. Renders nothing when everything fits (no scroll needed). */
export function Scrollbar({
  total,
  visible,
  offset,
  height,
  color,
}: {
  total: number;
  visible: number;
  offset: number;
  height: number;
  color: string;
}) {
  if (height <= 0 || total <= visible) return null;
  const maxOffset = Math.max(1, total - visible);
  const thumbH = Math.max(1, Math.min(height, Math.round((visible / total) * height)));
  const maxThumbTop = Math.max(0, height - thumbH);
  const thumbTop = Math.min(maxThumbTop, Math.round((offset / maxOffset) * maxThumbTop));
  const rows = [];
  for (let i = 0; i < height; i++) {
    const inThumb = i >= thumbTop && i < thumbTop + thumbH;
    rows.push(
      <Text key={i} color={inThumb ? color : "gray"} dimColor={!inThumb}>
        {inThumb ? "┃" : "│"}
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0} marginLeft={1}>
      {rows}
    </Box>
  );
}
