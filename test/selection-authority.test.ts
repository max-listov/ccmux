import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effortAccepted } from '../src/control/selection.ts';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';
import { selectionReceipt, writeSelection } from '../src/runtime/selection.ts';
import { NativeTurnOptionsSchema } from '../src/runtime/selectionSchema.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * Two authorities that must stay single: which effort levels exist, and what makes a repeated
 * request the same request.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a codex effort is judged by the catalog, not by a list in the schema', () => {
  // The schema does not name the levels: which exist is a property of the model, and the catalog
  // is the only authority on it. Both halves matter — nothing here accepts a level the catalog
  // withholds, and nothing here refuses one it offers.
  const options = NativeTurnOptionsSchema.parse({
    runtime: 'codex',
    model: { provider: 'openai', model: 'gpt-5' },
    mode: 'default',
    effort: 'a-level-invented-after-this-build',
  });
  expect('effort' in options && options.effort).toBe('a-level-invented-after-this-build');

  const row = { supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
  expect(effortAccepted(row, 'high')).toBe(true);
  expect(effortAccepted(row, 'a-level-invented-after-this-build')).toBe(false);
  // A row that lists none accepts none — that is what a model without the parameter reports.
  expect(effortAccepted({}, 'high')).toBe(false);
  expect(effortAccepted({}, undefined)).toBe(true);
});

test('a receipt written before the digest changed still replays instead of conflicting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-receipt-'));
  roots.push(root);
  const m = makeMachine({ stateDir: join(root, 'state') });
  const s = makeSession({
    name: 'agent-A',
    dir: root,
    agent: 'claude',
    runtime: 'native',
    registrationGeneration: '11111111-1111-4111-8111-111111111111',
  });
  const accepted = {
    revision: 1,
    options: NativeTurnOptionsSchema.parse({
      runtime: 'claude',
      model: { provider: 'anthropic', model: 'sonnet' },
    }),
  };
  const operationId = '22222222-2222-4222-8222-222222222222';
  const legacyDigest = 'a'.repeat(64);
  const currentDigest = 'b'.repeat(64);
  await writeSelection(m, s, accepted, operationId, legacyDigest);

  // The retry arrives computing its digest the new way. Offered both, the journal recognises its
  // own entry and answers it; offered only the new one it would call the request a conflict with
  // itself — a durable receipt outliving the code that wrote it is the whole point of keeping one.
  expect(selectionReceipt(m, s, operationId, [currentDigest, legacyDigest])).toEqual(accepted);
  expect(() => selectionReceipt(m, s, operationId, [currentDigest])).toThrow(
    'Selection request changed',
  );
});

test('an application policy is admitted for exactly the runtimes that declare it', () => {
  // The create path asks this capability instead of naming agents. The two answers must agree, and
  // the list that used to be spelled out at the call site did not: it omitted custom and claude
  // while the declaration includes neither, so reading the declaration is what keeps the admitted
  // set the same rather than quietly widening it.
  const declares = (agent: 'claude' | 'codex' | 'opencode' | 'custom', runtime: string) =>
    runtimeCapabilities({ agent, runtime } as never).applicationPolicy;
  expect(declares('codex', 'app-server')).toBe(true);
  expect(declares('opencode', 'native')).toBe(true);
  expect(declares('claude', 'native')).toBe(false);
  expect(declares('custom', 'native')).toBe(false);
  // A codex session that is not in its structured mode declares nothing at all.
  expect(declares('codex', 'tui')).toBe(false);
});
