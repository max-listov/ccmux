import { Box, Text } from 'ink';
import type { AgentKind } from '../../types.ts';
import type { DiscoveredSession } from '../discover.ts';
import { capabilityReasons, writerSummary } from '../fleet.ts';

export type Mode = 'list' | 'new' | 'confirm' | 'confirm-restart-all' | 'compose' | 'adopt';

/** The prompt a mode draws under the list: what is about to happen, and the keys that decide it. */
export function ModePrompt({
  mode,
  draft,
  agent,
  selectedName,
  managedCount,
  adopt,
  ownershipError,
}: {
  mode: Mode;
  /** The new session's name as it will be created. */
  draft: string;
  agent: AgentKind;
  selectedName: string | null;
  managedCount: number;
  adopt: DiscoveredSession | null;
  ownershipError: string | null;
}) {
  return (
    <>
      {mode === 'new' ? (
        <Box paddingX={2}>
          <Text>new session in </Text>
          <Text dimColor>{process.cwd()}</Text>
          <Text> → </Text>
          <Text color="cyan">{draft}</Text>
          <Text> provider: </Text>
          <Text color="yellow" bold>
            {agent}
          </Text>
          <Text dimColor> (tab)</Text>
          <Text>▏</Text>
        </Box>
      ) : null}
      {mode === 'confirm' && selectedName !== null ? (
        <Box paddingX={2}>
          <Text color="red" bold>
            delete {selectedName}?{' '}
          </Text>
          <Text dimColor>(history kept) </Text>
          <Text color="red">y / d</Text>
          <Text dimColor> delete · </Text>
          <Text>n / esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      ) : null}
      {mode === 'confirm-restart-all' ? (
        <Box paddingX={2}>
          <Text color="yellow" bold>
            restart ALL {managedCount} session{managedCount === 1 ? '' : 's'}?{' '}
          </Text>
          <Text dimColor>(one at a time, conversations kept) </Text>
          <Text color="yellow">y / R</Text>
          <Text dimColor> restart · </Text>
          <Text>n / esc</Text>
          <Text dimColor> cancel</Text>
        </Box>
      ) : null}
      {mode === 'adopt' ? (
        <Box paddingX={2} flexDirection="column">
          <Text>
            <Text color="yellow" bold>
              external ownership
            </Text>
            <Text dimColor>
              {adopt
                ? ` — ${adopt.provider}@${adopt.host} · ${adopt.threadId}`
                : ' — route disappeared'}
            </Text>
          </Text>
          <Text>
            <Text dimColor>{adopt ? `writer ${writerSummary(adopt)} · ` : ''}</Text>
            {adopt?.capabilities.fork ? (
              <>
                <Text color="green" bold>
                  f
                </Text>
                <Text dimColor> fork (provider-native, original untouched) · </Text>
              </>
            ) : null}
            {adopt?.capabilities.terminateAndAdopt ? (
              <>
                <Text color="red" bold>
                  t
                </Text>
                <Text dimColor> takeover (confirmed dedicated CLI only) · </Text>
              </>
            ) : null}
            {adopt?.capabilities.releaseAtSource ? (
              <Text dimColor>release at source before adopting · </Text>
            ) : null}
            {adopt ? <Text dimColor>{`${capabilityReasons(adopt)} · `}</Text> : null}
            <Text>esc</Text>
            <Text dimColor> cancel</Text>
          </Text>
          {ownershipError ? <Text color="red">{ownershipError}</Text> : null}
        </Box>
      ) : null}
    </>
  );
}
