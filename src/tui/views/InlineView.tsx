import { Box, Text, useStdout } from 'ink';
import { IS_DEV } from '../../util/env.ts';
import { VERSION } from '../../util/version.ts';
import { SessionCard } from '../components/SessionCard.tsx';
import type { FleetItem, FleetLoad } from '../fleet.ts';
import { emptyListText, externalActionHint, inventoryLabel } from '../fleet.ts';

/** Inline view — a stack of session cards (managed, then a separated section of live
 *  external sessions). Lives in the terminal stream, so it renders ONLY the cards that fit:
 *  a taller frame would be scrolled by the terminal itself, and the next repaint would drag the
 *  reader back down. `winStart`/`visibleCards` are the window App computed from the same
 *  geometry the arrow keys scroll with. */
export function InlineView({
  items,
  externalStart,
  cursor,
  winStart,
  visibleCards,
  spin,
  rcPrefix,
  load,
}: {
  items: FleetItem[];
  externalStart: number;
  cursor: number;
  winStart: number;
  visibleCards: number;
  spin: string;
  rcPrefix: string;
  load: FleetLoad;
}) {
  const { stdout } = useStdout();
  const lastWidth = Math.max(20, (stdout?.columns ?? 100) - 12);
  const externalCount = items.length - externalStart;
  const shown = items.slice(winStart, winStart + visibleCards);
  // Position, not a scrollbar: the window is the only thing on screen, so say which slice it is.
  const range =
    shown.length === items.length || items.length === 0
      ? ''
      : ` · ${winStart + 1}–${winStart + shown.length}/${items.length}`;
  return (
    <Box flexDirection="column" paddingY={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold>{`  ccmux v${VERSION} `}</Text>
          {IS_DEV ? (
            <Text color="yellow" bold>
              {'DEV '}
            </Text>
          ) : null}
          <Text bold>{'· fleet'}</Text>
        </Box>
        <Text
          dimColor
        >{`${externalStart} managed · ${inventoryLabel(load, externalCount)} · ${rcPrefix}${range}  `}</Text>
      </Box>
      <Box height={1} />
      {items.length === 0 ? (
        <Text
          dimColor
        >{`  ${load.loaded ? '' : `${spin} `}${emptyListText(load, 'press n to create one here')}`}</Text>
      ) : (
        shown.map((it, k) => {
          const i = winStart + k; // global index (the slice is the scroll window)
          return (
            <Box key={it.key} flexDirection="column">
              {i === externalStart ? (
                <Box paddingLeft={1}>
                  <Text color="magenta" dimColor>
                    ── external · local inventory outside ccmux ──
                  </Text>
                </Box>
              ) : null}
              <SessionCard
                item={it}
                selected={i === cursor}
                spin={spin}
                showDir={false}
                lastWidth={lastWidth}
              />
            </Box>
          );
        })
      )}
      <Text dimColor>
        {items[cursor]?.external && items[cursor]?.ext
          ? `  ↑↓ move   ${externalActionHint(items[cursor].ext)}   n new   x external   f fullscreen   q quit`
          : `  ↑↓ move   ↵ attach   n new   r restart   R all   s stop   D del   x external ${load.externalOn ? 'off' : 'on'}   f fullscreen   q quit`}
      </Text>
    </Box>
  );
}
