import { expect, test } from 'bun:test';
import { forkedUuid, providerFor } from '../src/agent/index.ts';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';
import { hasNativeRuntime } from '../src/runtime/modes.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * The interactive path, pinned before dispatch learns about execution modes.
 *
 * `providerFor` is keyed by agent kind alone, so a Claude row in any future execution mode would
 * inherit the pane-and-JSONL provider — its pane scanner, its menu answerer, its fork detector and
 * its transcript file. These tests state what the interactive mode must keep doing, so a change to
 * the dispatch key is proven not to move it rather than assumed not to.
 */

const claudeTui = () => makeSession({ name: 'agent-a', agent: 'claude' });

test('an interactive Claude session keeps the pane-and-transcript provider', () => {
  const provider = providerFor(claudeTui());
  expect(provider.id).toBe('claude');
  // The four capabilities that only exist because a pane and a JSONL file exist.
  expect(provider.historyFile).toBeDefined();
  expect(provider.scanPane).toBeDefined();
  expect(provider.promptAnswer).toBeDefined();
  expect(provider.detectFork).toBeDefined();
  expect(provider.inspectChatPane).toBeDefined();
});

test('an interactive Claude session is not a native runtime', () => {
  // The gate that keeps the structured paths away from a pane-driven session.
  expect(hasNativeRuntime(claudeTui())).toBe(false);
  expect(hasNativeRuntime(makeSession({ agent: 'claude', runtime: 'tui' }))).toBe(false);
});

test('the runtimes that already have a native mode are unchanged by the gate', () => {
  expect(hasNativeRuntime(makeSession({ agent: 'codex', runtime: 'app-server' }))).toBe(true);
  expect(hasNativeRuntime(makeSession({ agent: 'opencode', runtime: 'native' }))).toBe(true);
  expect(hasNativeRuntime(makeSession({ agent: 'custom', runtime: 'native' }))).toBe(true);
  // A native-capable agent still in its terminal mode is not native.
  expect(hasNativeRuntime(makeSession({ agent: 'codex', runtime: 'tui' }))).toBe(false);
});

test('native runtimes carry no pane or transcript parser, which is what makes them safe', () => {
  // This is the shape a Claude native row must acquire: no fork detection, no menu answering, no
  // history file. Inheriting the interactive provider instead is the defect these tests exist for.
  for (const agent of ['opencode', 'custom'] as const) {
    const provider = providerFor(makeSession({ agent, runtime: 'native' }));
    expect(provider.detectFork).toBeUndefined();
    expect(provider.promptAnswer).toBeUndefined();
    expect(provider.inspectChatPane).toBeUndefined();
    expect(provider.historyFile(makeSession({ agent }), makeMachine())).toBeNull();
  }
});

test('follow-the-fork is a Claude-and-Codex behaviour, and silence elsewhere is by construction', () => {
  // `forkedUuid` runs for every non-archived session on every heal pass. It returns null for a
  // provider with no fork detector — which is the only reason a native row survives that pass.
  const m = makeMachine();
  for (const agent of ['opencode', 'custom'] as const) {
    const s = makeSession({ agent, runtime: 'native' });
    expect(forkedUuid(s, m, [s])).toBeNull();
  }
});

test('a native Claude row gets a provider with no pane, no transcript and no fork detection', () => {
  // The whole point of keying dispatch on the pair. Inheriting the interactive provider here is
  // what would let follow-the-fork adopt an unrelated conversation and mismatch the identity
  // permanently — status unavailable, chat delivery throwing, `wait` exiting 2.
  const s = makeSession({ agent: 'claude', runtime: 'native' });
  const provider = providerFor(s);
  expect(provider.id).toBe('claude');
  expect(provider.detectFork).toBeUndefined();
  expect(provider.promptAnswer).toBeUndefined();
  expect(provider.inspectChatPane).toBeUndefined();
  expect(provider.historyFile(s, makeMachine())).toBeNull();
  expect(provider.scanPane('anything').state).toBe('indeterminate');
});

test('the heal pass cannot move a native Claude identity', () => {
  // `forkedUuid` runs for every non-archived session on every pass, ungated. With no fork detector
  // it returns null by construction rather than by a caller remembering to skip it.
  const s = makeSession({ agent: 'claude', runtime: 'native' });
  expect(forkedUuid(s, makeMachine(), [s])).toBeNull();
});

test('a native Claude row is native to the gate ~35 call sites read', () => {
  expect(hasNativeRuntime(makeSession({ agent: 'claude', runtime: 'native' }))).toBe(true);
});

test('its launch stamp argv is stable, so RESTART does not flicker', () => {
  // A drifting stamp would demand restarts for changes the runtime cannot act on — the reason the
  // Custom runtime uses a fictional-but-fixed argv rather than its real one.
  const s = makeSession({ agent: 'claude', runtime: 'native' });
  const m = makeMachine();
  const first = providerFor(s).buildArgv(s, m, 'claude', false);
  const second = providerFor(s).buildArgv(s, m, 'claude', true);
  expect(first).toEqual(second);
  expect(first.length).toBeGreaterThan(0);
});

test('declaring the Claude row for the native mode leaves the interactive row untouched', () => {
  // The declared record describes the native mode; `runtimeCapabilities` applies a degrade mask for
  // any session without a native runtime. This asserts the mask covers every upgraded key, so the
  // interactive answer is what it was before the row moved — the whole basis for calling this change
  // safe for the sessions that exist today.
  const tui = runtimeCapabilities({ agent: 'claude', runtime: 'tui' });
  expect(tui).toEqual({
    runtime: 'claude',
    structured: false,
    modelCatalog: false,
    modelSelection: false,
    approval: false,
    input: false,
    nativeStream: false,
    interrupt: false,
    resume: true,
    imageInput: false,
    selectionDefaults: false,
    turnOptions: false,
    turnSteering: false,
    commandCatalog: false,
    permissionModes: false,
    fileCheckpoints: false,
    mcpControl: false,
    history: false,
    fork: false,
    compaction: false,
    rollback: false,
    applicationPolicy: false,
  });
  // A Claude session with no runtime recorded at all is the same interactive answer.
  expect(runtimeCapabilities({ agent: 'claude' })).toEqual(tui);
});

test('the native mode reports structure, and promises nothing it cannot serve', () => {
  const native = runtimeCapabilities({ agent: 'claude', runtime: 'native' });
  expect(native).toMatchObject({
    structured: true,
    approval: true,
    input: true,
    nativeStream: true,
    interrupt: true,
    resume: true,
  });
  // A turn can name its model, its effort and its images, and each is served by the runtime itself.
  expect(native).toMatchObject({
    modelCatalog: true,
    modelSelection: true,
    turnOptions: true,
    selectionDefaults: true,
    imageInput: true,
    commandCatalog: true,
    permissionModes: true,
    fileCheckpoints: true,
    mcpControl: true,
    history: true,
    fork: true,
    compaction: true,
  });
  // No implementation exists behind these for Claude, so advertising them would be a promise the
  // control plane breaks on the first call.
  // Rollback alone stays refused: the runtime will not un-say a conversation, and pretending it
  // would is the promise the control plane breaks on the first call.
  expect(native).toMatchObject({ rollback: false });
});
