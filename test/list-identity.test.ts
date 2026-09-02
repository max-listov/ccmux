import { expect, test } from 'bun:test';
import { formatFleetSession, RemoteSessionSchema } from '../src/commands/fleetList.ts';
import { helpText } from '../src/commands/help.ts';
import { ListItemSchema } from '../src/config/schema.ts';

const baseItem = {
  name: 'agent-a',
  dir: '/Users/u/work',
  uuid: '11111111-1111-4111-8111-111111111111',
  rc: 'host-a-agent-a',
  running: true,
  archived: false,
  state: 'idle',
  lifecycleError: null,
  model: null,
  context: {
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
    rawLimitTokens: null,
    window: null,
  },
  account: null,
  planLimits: null,
  costUsd: null,
  uptime: { text: '1m', seconds: 60 },
  stale: [],
  createdAt: null,
  lastMessage: null,
};

test('list JSON requires the provider instead of inferring it', () => {
  expect(ListItemSchema.safeParse(baseItem).success).toBe(false);
  const parsed = ListItemSchema.parse({ ...baseItem, agent: 'codex' });
  expect(parsed.agent).toBe('codex');
});

test('fleet renders a missing remote provider as unknown, never Claude', () => {
  // Built through the peer schema: a row that reaches this function has been parsed by it.
  const line = formatFleetSession(
    'host-a',
    RemoteSessionSchema.parse({
      name: 'agent-a',
      state: 'idle',
      running: true,
      dir: '/src/agent-a',
      uptime: { text: '1m' },
    }),
  );
  expect(line).toContain('unknown');
  expect(line).not.toContain('claude');
});

test('human help makes provider-visible exact routing part of list and fleet', () => {
  expect(helpText('list')).toContain('explicit agent provider');
  expect(helpText('fleet')).toContain('full address');
  expect(helpText('fleet')).toContain('unknown, not Claude');
});
