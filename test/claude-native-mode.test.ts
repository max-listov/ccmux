import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeModels } from '../src/agent/claude/native/catalog.ts';
import { effortAccepted } from '../src/control/selection.ts';
import { ownedClaudeConversations } from '../src/external/claude.ts';
import { readRuntimeCatalog } from '../src/runtime/catalog.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * The opt-in native Claude execution mode, as the host and the control plane see it.
 *
 * Nothing here drives the SDK; these are the seams that decide whether the mode is offered at all,
 * and the promise that an operator who has not enabled it sees no change whatsoever.
 */

// Availability is decided by the binary being present, so the fixture provides a real path rather
// than a plausible one — a missing file answers "not configured" and would hide the flag's effect.
const root = mkdtempSync(join(tmpdir(), 'ccmux-claude-mode-'));
const claudeBin = join(root, 'claude');
writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const host = (over: Record<string, unknown> = {}) => makeMachine({ claudeBin, ...over });

const row = (m: ReturnType<typeof makeMachine>, mode: string) =>
  readRuntimeCatalog(m).runtimes.find((r) => r.runtime === 'claude' && r.mode === mode);

test('both Claude modes are reported, so a caller can tell them apart', () => {
  // A mode that is absent from the catalog cannot be distinguished from a build that has no such
  // mode at all, and those call for different actions by whoever is reading.
  const modes = readRuntimeCatalog(host())
    .runtimes.filter((r) => r.runtime === 'claude')
    .map((r) => r.mode);
  expect(modes).toEqual(['tui', 'native']);
});

test('a host that has not enabled the mode says so, and says it differently from missing', () => {
  const disabled = row(host(), 'native');
  expect(disabled).toMatchObject({ availability: 'unavailable', reason: 'runtime-not-enabled' });
  // Not the same answer as a host with no Claude binary at all.
  const absent = row(makeMachine({ claudeBin: join(root, 'absent-claude') }), 'native');
  expect(absent).toMatchObject({ availability: 'unavailable', reason: 'runtime-not-configured' });
});

test('the native row always advertises the structured capabilities of the mode', () => {
  // Capabilities describe what the mode IS, so they do not change with whether this host can start
  // it — availability is the field that answers that, and conflating the two would make a reader
  // unable to learn what the mode offers before enabling it.
  const enabled = row(host({ claudeNativeRuntime: true }), 'native');
  expect(enabled?.capabilities).toMatchObject({ structured: true, approval: true, input: true });
});

test('the interactive row is untouched by the flag in either position', () => {
  // The promise the whole task rests on: an operator who never enables the mode sees no change.
  const off = row(host(), 'tui');
  const on = row(host({ claudeNativeRuntime: true }), 'tui');
  expect(off).toEqual(on);
  expect(off).toMatchObject({ availability: 'configured', reason: null });
  expect(off?.capabilities.structured).toBe(false);
});

test('the other agents keep exactly one row each, with their established mode', () => {
  const rows = readRuntimeCatalog(host({ claudeNativeRuntime: true })).runtimes;
  for (const [runtime, mode] of [
    ['codex', 'app-server'],
    ['opencode', 'native'],
    ['custom', 'native'],
  ] as const) {
    const found = rows.filter((r) => r.runtime === runtime);
    expect(found).toHaveLength(1);
    expect(found[0]?.mode).toBe(mode);
  }
});

test('enabling the mode without an SDK to run is a third answer, not a vague failure', () => {
  // Three states, three actions: install the CLI, decide to enable the mode, point at an SDK that
  // exists. An operator told only "unavailable" has to guess which of the three applies to them.
  const enabled = row(host({ claudeNativeRuntime: true }), 'native');
  expect(enabled).toMatchObject({
    availability: 'unavailable',
    reason: 'runtime-sdk-unavailable',
  });
});

test('a configured SDK path that is not there is reported, not assumed to work', () => {
  const wrong = row(
    host({ claudeNativeRuntime: true, claudeNativeSdk: join(root, 'no-such-sdk') }),
    'native',
  );
  expect(wrong?.reason).toBe('runtime-sdk-unavailable');
});

test('the mode is available only when every part of it is', () => {
  const sdkRoot = join(root, 'sdk');
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(join(sdkRoot, 'sdk.mjs'), 'export const query = () => {};\n');
  const ready = row(host({ claudeNativeRuntime: true, claudeNativeSdk: sdkRoot }), 'native');
  expect(ready).toMatchObject({ availability: 'configured', reason: null });
});

test('a native conversation is owned by both its ids, so adoption cannot double-write it', () => {
  // Calls the production helper rather than re-implementing its `flatMap` inline: a test that builds
  // its own copy of the rule passes even after the rule is deleted, which is the one thing a
  // regression test must not do.
  const uuid = '33333333-3333-4333-8333-333333333333';
  const nativeId = '44444444-4444-4444-8444-444444444444';
  const native = makeSession({
    agent: 'claude',
    runtime: 'native',
    uuid,
    registrationGeneration: nativeId,
    nativeSession: { runtime: 'claude', id: nativeId, version: 'claude-agent-sdk' },
  });
  expect([...ownedClaudeConversations([native])].sort()).toEqual([uuid, nativeId].sort());
  // A terminal session contributes only its pinned uuid, exactly as before.
  expect([...ownedClaudeConversations([makeSession({ agent: 'claude', uuid })])]).toEqual([uuid]);
  // A non-Claude session contributes nothing to this set at all.
  expect([...ownedClaudeConversations([makeSession({ agent: 'codex', uuid })])]).toEqual([]);
});

test('effort levels are published per model, exactly as the runtime reported them', () => {
  // The runtime answers this per model — haiku accepts no effort while sonnet accepts five — so a
  // fixed list would admit a level on a model that rejects it and refuse one the runtime added.
  const rows = claudeModels(
    [
      { value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', supportsEffort: false, supportedEffortLevels: ['low'] },
      { value: 'quiet' },
    ],
    null,
  );
  expect(rows[0]?.supportedReasoningEfforts).toEqual([
    { reasoningEffort: 'low', description: '' },
    { reasoningEffort: 'high', description: '' },
  ]);
  // Reported as unsupported: the levels beside that flag are not an offer.
  expect(rows[1]?.supportedReasoningEfforts).toBeUndefined();
  // Silent about effort is not the same as offering every level.
  expect(rows[2]?.supportedReasoningEfforts).toBeUndefined();
});

test('an effort is checked against the row, whatever runtime asked for it', () => {
  // The check used to be written as a codex-only branch, so every native Claude turn carrying an
  // effort went through unvalidated — including 'high' on a model reporting no effort levels at all.
  const sonnet = { supportedReasoningEfforts: [{ reasoningEffort: 'low' }] };
  const haiku = {};
  expect(effortAccepted(sonnet, 'low')).toBe(true);
  expect(effortAccepted(sonnet, 'xhigh')).toBe(false);
  // A model that offers none accepts none — silence is not consent.
  expect(effortAccepted(haiku, 'high')).toBe(false);
  // Asking for no effort is always fine; that is the turn the session default runs.
  expect(effortAccepted(haiku, undefined)).toBe(true);
});
