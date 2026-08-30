import { expect, test } from 'bun:test';
import { formatFleetSession } from '../src/commands/fleetList.ts';
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
  context: { text: null, usedTokens: null, limitTokens: null, percent: null },
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
  const line = formatFleetSession('host-a', {
    name: 'agent-a',
    agent: null,
    state: 'idle',
    model: null,
    running: true,
    stale: [],
    dir: '/src/agent-a',
    role: null,
    turnStartedAt: null,
    uptime: { text: '1m' },
  });
  expect(line).toContain('unknown');
  expect(line).not.toContain('claude');
});

test('human help makes provider-visible exact routing part of list and fleet', () => {
  expect(helpText('list')).toContain('explicit agent provider');
  expect(helpText('fleet')).toContain('full address');
  expect(helpText('fleet')).toContain('unknown, not Claude');
});
