import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCommands,
  commandText,
  resolveCommand,
} from '../src/agent/claude/native/commands.ts';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';
import { readRuntimeMode, shouldRestoreMode } from '../src/runtime/sessionMode.ts';
import { managedRuntimeRoot } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * Slash commands and permission mode: the two ordinary controls the native mode lacked.
 *
 * Nothing here drives a runtime. These are the decisions made before anything is delivered — what
 * counts as a command this session offers, and exactly what text a command turn carries.
 */

test('a command keeps the runtime name, without the slash it is written with', () => {
  // The slash is how a person types it; storing both spellings invites matching on the wrong one.
  const [first, second] = claudeCommands([
    { name: '/compact', description: 'Compact the conversation', argumentHint: '' },
    { name: 'usage', aliases: ['/cost', 'stats'] },
  ]);
  expect(first?.name).toBe('compact');
  expect(second?.name).toBe('usage');
  expect(second?.aliases).toEqual(['cost', 'stats']);
  // A runtime that says nothing about a field says nothing — it does not get a placeholder invented.
  expect(second?.description).toBe('');
});

test('an alias resolves to its command, and an unknown name resolves to nothing', () => {
  const commands = claudeCommands([{ name: 'usage', aliases: ['cost'] }, { name: 'compact' }]);
  expect(resolveCommand(commands, 'cost')?.name).toBe('usage');
  expect(resolveCommand(commands, '/compact')?.name).toBe('compact');
  // Refusing here is the point: a command the runtime never named would be delivered as ordinary
  // text and answered as if someone had asked a question about it.
  expect(resolveCommand(commands, 'deploy')).toBeUndefined();
});

test('the delivered text is the command, and arguments are appended as typed', () => {
  const command = claudeCommands([{ name: 'compact' }])[0];
  if (command === undefined) throw new Error('the catalog dropped the command it was given');
  expect(commandText(command, undefined)).toBe('/compact');
  expect(commandText(command, '  keep the plan  ')).toBe('/compact keep the plan');
  // Empty arguments are not an empty argument: a trailing space would change what the runtime parses.
  expect(commandText(command, '   ')).toBe('/compact');
});

test('both controls are declared for the native mode and for no other', () => {
  const native = runtimeCapabilities({ agent: 'claude', runtime: 'native' });
  expect(native.commandCatalog).toBe(true);
  expect(native.permissionModes).toBe(true);
  const tui = runtimeCapabilities({ agent: 'claude', runtime: 'tui' });
  expect(tui.commandCatalog).toBe(false);
  expect(tui.permissionModes).toBe(false);
});

test('a mode a session was given is restored on restart, and only that one', () => {
  const generation = '33333333-3333-4333-8333-333333333333';
  const other = '44444444-4444-4444-8444-444444444444';
  const request = (over: Record<string, unknown> = {}) =>
    ({
      operationId: '55555555-5555-4555-8555-555555555555',
      generation,
      mode: 'plan',
      phase: 'complete',
      reason: null,
      ...over,
    }) as never;
  // The restart dropped it silently before — and the drop went the dangerous way, from a mode that
  // asks before writing to one that asks less.
  expect(shouldRestoreMode(request(), generation)).toBe(true);
  // A request nobody accepted is not a mode the session was in.
  expect(shouldRestoreMode(request({ phase: 'queued' }), generation)).toBe(false);
  // A request from a conversation that no longer exists must never govern the one that replaced it.
  expect(shouldRestoreMode(request({ generation: other }), generation)).toBe(false);
  // `default` is where a runtime starts; restoring it would be a call that changes nothing.
  expect(shouldRestoreMode(request({ mode: 'default' }), generation)).toBe(false);
  expect(shouldRestoreMode(null, generation)).toBe(false);
});

test('a mode recorded by an earlier build is read, not discarded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-mode-'));
  const m = makeMachine({ stateDir: join(root, 'state') });
  const generation = '33333333-3333-4333-8333-333333333333';
  const s = makeSession({
    name: 'agent-A',
    dir: root,
    agent: 'claude',
    runtime: 'native',
    registrationGeneration: generation,
  });
  const dir = managedRuntimeRoot(m, s);
  mkdirSync(dir, { recursive: true });
  // The shape written before the request carried an operation id. Refusing it would put a session
  // that was in `plan` back into `default` on the first restart after an upgrade — a downgrade to
  // the mode that asks less, performed by the code whose whole job is to prevent that.
  writeFileSync(
    join(dir, 'permission-mode.json'),
    JSON.stringify({ generation, mode: 'plan', phase: 'accepted', reason: null }),
    { mode: 0o600 },
  );
  const read = readRuntimeMode(m, s);
  expect(read?.mode).toBe('plan');
  expect(read?.phase).toBe('complete');
  expect(shouldRestoreMode(read, generation)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
