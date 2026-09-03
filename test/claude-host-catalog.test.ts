import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeModels, validateClaudeSelection } from '../src/agent/claude/native/catalog.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { ControlModelsReadSchema } from '../src/control/schema.ts';
import { managedRuntimeRoot } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * Choosing a model happens BEFORE the session that will carry the choice exists, so "ask a running
 * session" is a circle: the list needs a session, the session needs the list. The way out is that
 * the list is not a property of a conversation — it is what the installed CLI offers, and every
 * owner on the host is handed the same one at startup.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const model = {
  provider: 'claude',
  id: 'sonnet',
  model: 'sonnet',
  displayName: 'Sonnet',
  description: '',
  hidden: false,
  isDefault: true,
  inputModalities: ['text', 'image'],
  serviceTiers: [],
};

async function host(options: { sdk: boolean; publish: boolean; observedAt?: string }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-host-catalog-'));
  roots.push(stateDir);
  const sdk = join(stateDir, 'sdk');
  mkdirSync(sdk, { recursive: true });
  if (options.sdk) writeFileSync(join(sdk, 'sdk.mjs'), 'export {};');
  const m = makeMachine({
    stateDir,
    claudeNativeRuntime: true,
    claudeNativeSdk: sdk,
  });
  const session = makeSession({
    name: 'agent-A',
    agent: 'claude',
    runtime: 'native',
    registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: 'claude', id: crypto.randomUUID(), version: '2.0.0' },
  });
  await writeSessionsUnlocked(m, [session]);
  if (options.publish) {
    const dir = managedRuntimeRoot(m, session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        registrationGeneration: session.registrationGeneration,
        ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
        models: [model],
      }),
      { mode: 0o600 },
    );
  }
  return { m, session };
}

const read = ControlModelsReadSchema.parse({ runtime: 'claude' });

test('a host answers with the list its last owner published, and says it is not live', async () => {
  const observedAt = '2026-09-01T10:00:00.000Z';
  const { m } = await host({ sdk: true, publish: true, observedAt });
  const page = readClaudeModels(m, read, undefined);
  expect(page.data.map((row) => row.model)).toEqual(['sonnet']);
  expect(page.source.kind).toBe('host');
  expect(page.source.observedAt).toBe(observedAt);
  // The publisher is not running: the list is still the best answer this host has, and saying it
  // is current would be the lie. `stale` is a description, not a failure.
  expect(page.source.freshness).toBe('stale');
});

test('a catalog written before the field existed is dated by its file, not discarded', async () => {
  const { m } = await host({ sdk: true, publish: true });
  const page = readClaudeModels(m, read, undefined);
  expect(page.data).toHaveLength(1);
  expect(page.source.observedAt).not.toBeNull();
});

test('a host that does not run this mode says so, rather than answering with nothing', async () => {
  const { m } = await host({ sdk: false, publish: true });
  // Three different answers because they call for three different actions. An empty array would
  // tell a chooser the runtime offers no models, which is a different and false statement.
  expect(() => readClaudeModels(m, read, undefined)).toThrow('does not publish a catalog');
});

test('a host that runs it but has never held it says nothing has been observed', async () => {
  const { m } = await host({ sdk: true, publish: false });
  expect(() => readClaudeModels(m, read, undefined)).toThrow('has published its catalog');
});

test('a create is refused for a model this host never published, and told which one', async () => {
  const { m } = await host({ sdk: true, publish: true });
  // The published key passes untouched, brackets and all — the catalog decides, nothing else.
  expect(() => validateClaudeSelection(m, { provider: 'claude', model: 'sonnet' })).not.toThrow();
  expect(() =>
    validateClaudeSelection(m, { provider: 'claude', model: 'no-such-model[9q]' }),
  ).toThrow("Model claude/no-such-model[9q] is absent from this host's catalog");
});

test('a host that has published nothing cannot judge a selection, and does not pretend to', async () => {
  // Three outcomes, not two: no owner has ever asked this runtime here, so the honest answer is
  // "cannot tell" and the runtime refuses at admission. A refusal here would make the first native
  // session on a fresh host impossible — a rejection built out of an unread file.
  const { m } = await host({ sdk: true, publish: false });
  expect(() =>
    validateClaudeSelection(m, { provider: 'claude', model: 'no-such-model[9q]' }),
  ).not.toThrow();
});
