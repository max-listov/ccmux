import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Discovery, loadCatalog } from '../src/agent/claude/native/discovery.ts';
import { NativeProjection } from '../src/agent/claude/native/projection.ts';
import { readSelection } from '../src/runtime/selection.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * What a caller cannot check for itself.
 *
 * A create passes a model NAME and gets a receipt back; nothing in that exchange shows what the
 * runtime did with the name. The durable selection written at admission is the evidence — every
 * other runtime already writes one, and this one did not, so a consumer verifying delivery had to
 * either trust the receipt or refuse the runtime.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const supported = [
  { value: 'default', displayName: 'Default', description: '' },
  { value: 'sonnet', displayName: 'Sonnet', description: '' },
];

async function discover(requested?: string): Promise<Discovery> {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-admission-selection-'));
  roots.push(stateDir);
  const m = makeMachine({ stateDir, claudeNativeRuntime: true });
  const session = makeSession({
    name: 'agent-a',
    // A native Claude session cannot open without one; the owner refuses first.
    registrationGeneration: '33333333-3333-4333-8333-333333333333',
    ...(requested === undefined
      ? {}
      : { modelSelection: { provider: 'claude', model: requested } }),
  });
  const d: Discovery = {
    m,
    session,
    query: { supportedModels: async () => supported } as never,
    projection: new NativeProjection(),
    report: async (error: unknown) => {
      throw error;
    },
  };
  await loadCatalog(d);
  return d;
}

test('a chosen model is published as admission evidence, not only inside the receipt', async () => {
  const d = await discover('sonnet');
  const selection = readSelection(d.m, d.session);
  expect(selection?.options).toEqual({
    runtime: 'claude',
    model: { provider: 'claude', model: 'sonnet' },
  });
  // Revision zero: admission, not a turn that changed the model afterwards.
  expect(selection?.revision).toBe(0);
});

test('a model the runtime does not offer is never published as accepted', async () => {
  // Publishing it would turn a name that will fail at the first turn into evidence that it arrived.
  const d = await discover('a-model-that-does-not-exist');
  expect(readSelection(d.m, d.session)).toBeNull();
});

test('a session that chose nothing has no delivery to confirm', async () => {
  // Seeding a default nobody asked for would invent a choice and then attest to it.
  const d = await discover();
  expect(readSelection(d.m, d.session)).toBeNull();
});
