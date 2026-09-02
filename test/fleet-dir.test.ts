import { expect, test } from 'bun:test';
import { z } from 'zod';
import { type FleetMachine, fleetView, RemoteSessionSchema } from '../src/commands/fleetList.ts';
import { ListJsonSchema } from '../src/config/schema.ts';

// A fleet consumer joins a session to a project by matching its checkout path — longest same-host
// prefix wins. That needs the directory the owner DECLARED, byte for byte: shortening it, resolving
// a symlink or trimming a trailing slash each silently changes which project it matches. Without the
// field at all, the only thing left to match on is the session NAME, which a person chose and which
// is usually the project's — the exact guess that has misrouted work on this fleet before.

/**
 * The peer answer shape is no longer restated here.
 *
 * It used to be mirrored so the test would notice the contract being narrowed — and the mirror
 * itself became the narrowing: every field added to the local row had to be copied into two schemas
 * and a fixture, and a field missing from any of them read as "that session has nothing to show".
 * The real schema is derived from the local row now, so the property this file cares about is
 * asserted against it directly.
 */
const RemoteSession = RemoteSessionSchema;

test('the fleet row is the local row, so a field cannot arrive on one path and vanish on the other', () => {
  // The drift this replaces: `waitingFor`, the context window, the last message and the plan limits
  // each shipped present locally and absent remotely, because the two shapes were written twice.
  const local = new Set(Object.keys(ListJsonSchema.shape.sessions.element.shape));
  const remote = new Set(Object.keys(RemoteSessionSchema.shape));
  expect([...local].filter((field) => !remote.has(field))).toEqual([]);
});

test('a local fleet row carries the directory exactly as `list --json` reports it', () => {
  // Same source, same string. A fleet view that quietly differed from the single-machine view about
  // the same session would be worse than one that omitted the field.
  const dir = '/Users/u/src/api';
  const item = ListJsonSchema.shape.sessions.element.parse({
    name: 'agent-a',
    agent: 'claude',
    dir,
    uuid: '11111111-1111-4111-8111-111111111111',
    rc: 'rc',
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
    uptime: { text: '1m', seconds: 60 },
    createdAt: null,
    lastMessage: null,
  });
  expect(item.dir).toBe(dir);
  expect(RemoteSession.parse({ name: 'agent-a', dir }).dir).toBe(dir);
});

test('the directory is transported, never interpreted', () => {
  // A trailing slash, a symlinked home, an unusual character: all of them change a prefix match, and
  // none of them are ccmux's to decide. What the directory MEANS belongs to whoever keeps the
  // catalogue; ccmux only knows what the session declared.
  for (const dir of ['/Users/u/src/api/', '/var/tmp/../src/api', '/src/проект', '/src/a b/c']) {
    expect(RemoteSession.parse({ name: 'agent-a', dir }).dir).toBe(dir);
  }
});

test('a peer too old to report it yields null, and its other sessions still arrive', () => {
  // The compatibility that matters: one missing field must not cost a machine. `null` says "that
  // build does not report it", which a consumer can tell from "declared nowhere".
  const parsed = z.object({ sessions: z.array(RemoteSession).default([]) }).parse({
    sessions: [{ name: 'agent-a' }, { name: 'agent-b', dir: '/src/b' }],
  });
  expect(parsed.sessions.map((s) => s.dir)).toEqual([null, '/src/b']);
  expect(parsed.sessions).toHaveLength(2);
});

test('the field rides through the fleet view untouched', () => {
  const machine: FleetMachine = {
    machine: 'host-a',
    alias: null,
    ok: true,
    error: null,
    version: '0.37.0',
    release: null,
    behind: null,
    sessions: [RemoteSession.parse({ name: 'agent-a', dir: '/Users/u/src/api' })],
  };
  const view = fleetView([machine]);
  expect(view.machines[0]?.sessions[0]?.dir).toBe('/Users/u/src/api');
});
