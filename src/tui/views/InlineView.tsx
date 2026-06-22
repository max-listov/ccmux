import { Box, Text, useStdout } from "ink";
import { VERSION } from "../../util/version.ts";
import { IS_DEV } from "../../env.ts";
import { SessionCard } from "../components/SessionCard.tsx";
import type { FleetItem } from "../fleet.ts";

/** Inline view — a stack of session cards (managed, then a separated section of live
 *  external sessions). Lives in the terminal stream. */
export function InlineView({ items, externalStart, cursor, spin, rcPrefix }: { items: FleetItem[]; externalStart: number; cursor: number; spin: string; rcPrefix: string }) {
  const { stdout } = useStdout();
  const lastWidth = Math.max(20, (stdout?.columns ?? 100) - 12);
  const externalCount = items.length - externalStart;
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold>{`  ccmux v${VERSION} `}</Text>
          {IS_DEV ? <Text color="yellow" bold>{"DEV "}</Text> : null}
          <Text bold>{"· fleet"}</Text>
        </Box>
        <Text dimColor>{`${externalStart} managed · ${externalCount} external · ${rcPrefix}  `}</Text>
      </Box>
      <Box height={1} />
      {items.length === 0 ? (
        <Text dimColor>  no sessions — press n to create one here</Text>
      ) : (
        items.map((it, i) => (
          <Box key={it.row.session.uuid} flexDirection="column">
            {i === externalStart ? (
              <Box paddingLeft={1}>
                <Text color="magenta" dimColor>── external · live outside ccmux (read-only) ──</Text>
              </Box>
            ) : null}
            <SessionCard item={it} selected={i === cursor} spin={spin} showDir={false} lastWidth={lastWidth} />
          </Box>
        ))
      )}
      <Text dimColor>
        {items[cursor]?.external
          ? "  ↑↓ move   a adopt   n new   f fullscreen   q quit"
          : "  ↑↓ move   ↵ attach   n new   r restart   s stop   D del   f fullscreen   q quit"}
      </Text>
    </Box>
  );
}
