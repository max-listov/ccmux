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

/** A stdout-less stand-in for the vendor SDK: a real module, imported the way the real one is. */
const FAKE_SDK = `
export function query({ prompt, options }) {
  const calls = [];
  globalThis.__probeCalls ??= [];
  globalThis.__probeCalls.push({ cwd: options.cwd, bin: options.pathToClaudeCodeExecutable });
  return {
    supportedModels: async () => [
      { value: 'sonnet', displayName: 'Sonnet', description: 'd', resolvedModel: 'claude-sonnet-5' },
      { value: 'opus[1m]', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low'] },
    ],
    return: () => {
      globalThis.__probeClosed = (globalThis.__probeClosed ?? 0) + 1;
    },
  };
}
`;

async function host(options: {
  sdk: boolean;
  publish: boolean;
  observedAt?: string;
  sdkSource?: string;
}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-host-catalog-'));
  roots.push(stateDir);
  const sdk = join(stateDir, 'sdk');
  mkdirSync(sdk, { recursive: true });
  if (options.sdk) writeFileSync(join(sdk, 'sdk.mjs'), options.sdkSource ?? 'export {};');
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
const signal = () => new AbortController().signal;

test('a host answers with the list its last owner published, and says it is not live', async () => {
  const observedAt = '2026-09-01T10:00:00.000Z';
  const { m } = await host({ sdk: true, publish: true, observedAt });
  const page = await readClaudeModels(m, read, undefined, signal());
  expect(page.data.map((row) => row.model)).toEqual(['sonnet']);
  expect(page.source.kind).toBe('host');
  expect(page.source.observedAt).toBe(observedAt);
  // The publisher is not running: the list is still the best answer this host has, and saying it
  // is current would be the lie. `stale` is a description, not a failure.
  expect(page.source.freshness).toBe('stale');
});

test('a catalog written before the field existed is dated by its file, not discarded', async () => {
  const { m } = await host({ sdk: true, publish: true });
  const page = await readClaudeModels(m, read, undefined, signal());
  expect(page.data).toHaveLength(1);
  expect(page.source.observedAt).not.toBeNull();
});

test('a host that does not run this mode says so, rather than answering with nothing', async () => {
  const { m } = await host({ sdk: false, publish: true });
  // Three different answers because they call for three different actions. An empty array would
  // tell a chooser the runtime offers no models, which is a different and false statement.
  await expect(readClaudeModels(m, read, undefined, signal())).rejects.toThrow(
    'does not publish a catalog',
  );
});

test('a host that has never held it asks the installation itself, without a conversation', async () => {
  // The circle this breaks: choosing a model precedes the create that would produce the first
  // publisher, so a fresh host could only be started by a command typed on the machine. The list
  // was never a property of a conversation — the runtime answers it on a connection given no turn.
  const { m } = await host({ sdk: true, publish: false, sdkSource: FAKE_SDK });
  const page = await readClaudeModels(m, read, undefined, signal());
  expect(page.data.map((row) => row.model)).toEqual(['sonnet', 'opus[1m]']);
  expect(page.source.kind).toBe('host');
  expect(page.source.freshness).toBe('live');
  expect(page.source.observedAt).not.toBeNull();
  // Closed in a `finally`: a supervisor that leaves a runtime child behind is the orphan case this
  // project already knows, and this one is started by a read that answers in seconds.
  expect((globalThis as { __probeClosed?: number }).__probeClosed).toBeGreaterThanOrEqual(1);
});

test('a host whose runtime cannot be asked names the action, not just the state', async () => {
  const { m } = await host({ sdk: true, publish: false });
  // A sentence reporting only that nothing has been observed here is what sent people to the
  // machine to type a command nobody had told them.
  const failure = readClaudeModels(m, read, undefined, signal());
  await expect(failure).rejects.toThrow('No session on this host has published its catalog');
  await expect(failure).rejects.toThrow('ccmux new <name> <dir> --agent claude --runtime native');
});

test('two reads of the same host start one child, not one each', async () => {
  // A chooser that opens a catalog asks more than once — pages, a refresh, a second panel — and
  // every one of those would otherwise spawn the runtime again for an answer that describes an
  // installation rather than a moment.
  const { m } = await host({ sdk: true, publish: false, sdkSource: FAKE_SDK });
  const calls = () => ((globalThis as { __probeCalls?: unknown[] }).__probeCalls ?? []).length;
  const before = calls();
  const [first, second] = await Promise.all([
    readClaudeModels(m, read, undefined, signal()),
    readClaudeModels(m, read, undefined, signal()),
  ]);
  await readClaudeModels(m, read, undefined, signal());
  expect(first.data).toEqual(second.data);
  expect(calls() - before).toBe(1);
});

test('a published catalog is preferred to a probe: the host is not asked at all', async () => {
  const { m } = await host({ sdk: true, publish: true, sdkSource: FAKE_SDK });
  const before = ((globalThis as { __probeCalls?: unknown[] }).__probeCalls ?? []).length;
  const page = await readClaudeModels(m, read, undefined, signal());
  expect(page.data.map((row) => row.model)).toEqual(['sonnet']);
  expect(((globalThis as { __probeCalls?: unknown[] }).__probeCalls ?? []).length).toBe(before);
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
