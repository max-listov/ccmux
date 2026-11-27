import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { bridgePreviousCommand } from '../src/boot/installedApp.ts';
import {
  adoptNewBootLabels,
  adoptPreviousEnv,
  migrateFromCcmux,
  type RenameGateDeps,
  renameGate,
  renamePending,
} from '../src/migration/renameFromCcmux.ts';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// The machine's own environment: no explicit root overrides, everything under this home.
const env = (home: string) => ({ HOME: home }) as NodeJS.ProcessEnv;

function legacyMachine() {
  const home = realpathSync(mkdtempSync('/tmp/stitchmux-rename-'));
  homes.push(home);
  const config = join(home, '.config', 'ccmux');
  const state = join(home, '.local', 'state', 'ccmux');
  mkdirSync(join(config, 'services'), { recursive: true });
  mkdirSync(join(state, 'attachments'), { recursive: true });
  mkdirSync(join(home, '.cache', 'ccmux'), { recursive: true });
  writeFileSync(
    join(config, 'machine.json'),
    JSON.stringify({
      bootLabel: 'com.ccmux.daemon',
      remoteTransport: { kind: 'stitchwire', serviceDirectory: `${config}/services` },
    }),
  );
  writeFileSync(join(config, 'services', 'ccmux.control.callers.json'), '[]');
  writeFileSync(join(state, 'ccmux.log'), 'old log\n');
  const peer = (session: string) =>
    `{"kind":"managed","source":"ccmux","machine":"host-a","agent":"claude","session":"${session}","threadId":"t"}`;
  writeFileSync(
    join(state, 'chat.jsonl'),
    `{"id":"1","from":${peer('ccmux-cc2')},"to":${peer('agent-b')},"body":"quote: \\"source\\":\\"ccmux\\" and \\"ccmux:x\\""}\n`,
  );
  writeFileSync(
    join(state, 'chat-cursors.json'),
    JSON.stringify({ read: { 'ccmux:host-a:claude:agent-b:t': 3 } }),
  );
  writeFileSync(
    join(state, 'sessions.jsonl'),
    `${JSON.stringify({ name: 'ccmux-cc2', dir: '/w/projects/ccmux/ccmux', envFile: `${config}/profiles/claude-2.env` })}\n`,
  );
  return { home, config, state };
}

test('a machine under the previous name moves its directories, file names and identifiers once', () => {
  const { home, config, state } = legacyMachine();
  const report = migrateFromCcmux(env(home), home);
  expect(report?.conflicts).toEqual([]);
  const newConfig = join(home, '.config', 'stitchmux');
  const newState = join(home, '.local', 'state', 'stitchmux');
  // The previous paths are links to the moved roots: supervisors of sessions started before the
  // update still resolve them, and must land in the moved directory, not in a new empty one.
  expect([
    lstatSync(config).isSymbolicLink() && readlinkSync(config),
    lstatSync(state).isSymbolicLink() && readlinkSync(state),
    lstatSync(newConfig).isDirectory(),
    lstatSync(newState).isDirectory(),
  ]).toEqual([newConfig, newState, true, true]);
  expect(readlinkSync(join(home, '.cache', 'ccmux'))).toBe(join(home, '.cache', 'stitchmux'));
  expect(existsSync(join(home, '.local', 'state', 'stitchmux', '.renamed-from-ccmux'))).toBe(true);
  expect(renamePending(env(home), home)).toBe(false);
  expect(existsSync(join(newState, 'stitchmux.log'))).toBe(true);
  expect(existsSync(join(newConfig, 'services', 'stitchmux.control.callers.json'))).toBe(true);

  const machine = JSON.parse(readFileSync(join(newConfig, 'machine.json'), 'utf8'));
  // The daemon may still run under the previous unit: its label moves only at install.
  expect(machine.bootLabel).toBe('com.ccmux.daemon');
  expect(machine.remoteTransport.serviceDirectory).toBe(`${newConfig}/services`);

  const chat = readFileSync(join(newState, 'chat.jsonl'), 'utf8');
  expect(chat).not.toContain('"source":"ccmux"');
  expect(chat).toContain('"source":"stitchmux"');
  // Words inside a message body are the message, and a session's name is its own.
  expect(chat).toContain('\\"source\\":\\"ccmux\\" and \\"ccmux:x\\"');
  expect(chat).toContain('"session":"ccmux-cc2"');

  expect(JSON.parse(readFileSync(join(newState, 'chat-cursors.json'), 'utf8'))).toEqual({
    read: { 'stitchmux:host-a:claude:agent-b:t': 3 },
  });
  const session = JSON.parse(readFileSync(join(newState, 'sessions.jsonl'), 'utf8'));
  expect(session).toEqual({
    name: 'ccmux-cc2',
    dir: '/w/projects/ccmux/ccmux',
    envFile: `${newConfig}/profiles/claude-2.env`,
  });

  expect(migrateFromCcmux(env(home), home)).toBeNull();
});

test('an entry present under both names stops the move and is reported', () => {
  const { home, state } = legacyMachine();
  const newState = join(home, '.local', 'state', 'stitchmux');
  mkdirSync(newState, { recursive: true });
  writeFileSync(join(newState, 'chat.jsonl'), '');
  const report = migrateFromCcmux(env(home), home);
  expect(report?.conflicts).toEqual([join(state, 'chat.jsonl')]);
  expect(existsSync(join(state, 'chat.jsonl'))).toBe(true);
  expect(existsSync(join(newState, '.renamed-from-ccmux'))).toBe(false);
});

test('a root pinned by an explicit override is left alone', () => {
  const { home, state } = legacyMachine();
  const pinned = { ...env(home), STITCHMUX_STATE_DIR: join(home, 'elsewhere') };
  migrateFromCcmux(pinned, home);
  expect(existsSync(state)).toBe(true);
});

test('a letter or call from a peer on the previous release reads as this release’s principal', () => {
  const { adoptPreviousSource } = require('../src/migration/renameFromCcmux.ts');
  expect(
    adoptPreviousSource({
      from: { kind: 'managed', source: 'ccmux', session: 'ccmux-cc2' },
      body: 'source ccmux',
      list: [{ source: 'ccmux' }, { source: 'codex-app' }],
    }),
  ).toEqual({
    from: { kind: 'managed', source: 'stitchmux', session: 'ccmux-cc2' },
    body: 'source ccmux',
    list: [{ source: 'stitchmux' }, { source: 'codex-app' }],
  });
});

test('a session started before the release keeps its variables under the new names', () => {
  const { adoptPreviousEnv } = require('../src/migration/renameFromCcmux.ts');
  const env: NodeJS.ProcessEnv = {
    CCMUX_SESSION: 'agent-a',
    STITCHMUX_CONFIG: '/x',
    CCMUX_CONFIG: '/old',
  };
  adoptPreviousEnv(env);
  expect(env.STITCHMUX_SESSION).toBe('agent-a');
  expect(env.STITCHMUX_CONFIG).toBe('/x');
});

test('the data directory a running bundle lives in is copied, and its copy is dropped only from the new place', async () => {
  const { home } = legacyMachine();
  const data = join(home, '.local', 'share', 'ccmux');
  const next = join(home, '.local', 'share', 'stitchmux');
  mkdirSync(join(data, 'app'), { recursive: true });
  mkdirSync(join(data, 'claude-agent-sdk'), { recursive: true });
  writeFileSync(join(data, 'app', 'ccmux.js'), 'bundle');
  writeFileSync(join(data, 'app', 'ccmux.js.bak'), 'previous');
  writeFileSync(join(data, 'claude-agent-sdk', 'sdk.js'), 'sdk');
  const running = join(data, 'app', 'ccmux.js');
  const report = migrateFromCcmux(env(home), home, running);
  expect(report?.deferred).toEqual([data]);
  // Everything this release points at exists at the new root before it is written anywhere.
  expect(readFileSync(join(next, 'app', 'stitchmux.js'), 'utf8')).toBe('bundle');
  expect(readFileSync(join(next, 'app', 'stitchmux.js.bak'), 'utf8')).toBe('previous');
  expect(readFileSync(join(next, 'claude-agent-sdk', 'sdk.js'), 'utf8')).toBe('sdk');
  expect(readFileSync(running, 'utf8')).toBe('bundle');
  // Every command works from here: only the code copy is left to drop.
  expect(renamePending(env(home), home)).toBe(false);
  expect(await renameGate('msg', gateDeps(home, { runningBundle: running }))).toBeNull();
  // The daemon the boot unit still starts from the legacy copy keeps it.
  expect(await renameGate('daemon', gateDeps(home, { runningBundle: running }))).toBeNull();
  expect(existsSync(running)).toBe(true);
  const marker = join(home, '.local', 'state', 'stitchmux', '.renamed-from-ccmux');
  expect(existsSync(marker)).toBe(false);
  // Started from the new place after `stitchmux install`, it drops the copy and finishes the move.
  const installed = join(next, 'app', 'stitchmux.js');
  expect(await renameGate('daemon', gateDeps(home, { runningBundle: installed }))).toBeNull();
  expect(existsSync(data)).toBe(false);
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(installed, 'utf8')).toBe('bundle');
});

test('after the reinstall the previous release’s code copy is dropped, not reported as a conflict', () => {
  const { home } = legacyMachine();
  const legacyData = join(home, '.local', 'share', 'ccmux');
  const data = join(home, '.local', 'share', 'stitchmux');
  mkdirSync(join(legacyData, 'app'), { recursive: true });
  writeFileSync(join(legacyData, 'app', 'ccmux.js'), 'old');
  mkdirSync(join(data, 'app'), { recursive: true });
  writeFileSync(join(data, 'app', 'stitchmux.js'), 'new');
  const report = migrateFromCcmux(env(home), home, join(data, 'app', 'stitchmux.js'));
  expect(report?.conflicts).toEqual([]);
  expect(existsSync(legacyData)).toBe(false);
  expect(readFileSync(join(data, 'app', 'stitchmux.js'), 'utf8')).toBe('new');
});

function gateDeps(
  home: string,
  over: Partial<RenameGateDeps> = {},
): RenameGateDeps & { stops: number } {
  const deps = {
    stops: 0,
    env: env(home),
    home,
    self: [100, 99],
    runningBundle: '/elsewhere/stitchmux.js',
    ps: () =>
      '   99 /Applications/x.app/launcher bun /a/stitchmux.js daemon\n  100 bun /a/stitchmux.js daemon\n',
    stopPreviousDaemon: async () => {
      deps.stops += 1;
    },
    ...over,
  };
  return deps;
}

test('a command other than the daemon or install refuses on a machine that has not moved, and moves nothing', async () => {
  const { home, state } = legacyMachine();
  for (const command of ['list', 'msg', 'status-line', undefined]) {
    const refusal = await renameGate(command, gateDeps(home));
    expect(refusal).toContain('previous name');
  }
  expect(existsSync(join(state, 'chat.jsonl'))).toBe(true);
  expect(existsSync(join(home, '.local', 'state', 'stitchmux'))).toBe(false);
});

test('the starting daemon does not move the state while another daemon is running', async () => {
  const { home, state } = legacyMachine();
  const ps = () =>
    '  100 bun /a/stitchmux.js daemon\n 4242 /usr/bin/bun /h/.local/share/ccmux/app/ccmux.js daemon\n';
  expect(await renameGate('daemon', gateDeps(home, { ps }))).toContain('pid 4242');
  expect(existsSync(join(state, 'chat.jsonl'))).toBe(true);
});

test('the starting daemon, alone, moves the state; later commands then run', async () => {
  const { home } = legacyMachine();
  const deps = gateDeps(home);
  expect(await renameGate('daemon', deps)).toBeNull();
  expect(deps.stops).toBe(0);
  expect(existsSync(join(home, '.local', 'state', 'stitchmux', 'chat.jsonl'))).toBe(true);
  expect(await renameGate('list', deps)).toBeNull();
});

test('install stops the previous daemon unit before it moves anything', async () => {
  const { home } = legacyMachine();
  let running = true;
  const deps = gateDeps(home, {
    ps: () => (running ? ' 4242 bun /h/.local/share/ccmux/app/ccmux.js daemon\n' : ''),
    stopPreviousDaemon: async () => {
      running = false;
    },
  });
  expect(await renameGate('install', deps)).toBeNull();
  expect(existsSync(join(home, '.local', 'state', 'stitchmux', 'chat.jsonl'))).toBe(true);
});

test('the previous unit’s default config path is not carried over; an operator override is', () => {
  const home = '/h';
  const fromUnit: NodeJS.ProcessEnv = { CCMUX_CONFIG: '/h/.config/ccmux/machine.json' };
  adoptPreviousEnv(fromUnit, home);
  expect(fromUnit.STITCHMUX_CONFIG).toBeUndefined();
  const own: NodeJS.ProcessEnv = { CCMUX_CONFIG: '/srv/fleet/machine.json' };
  adoptPreviousEnv(own, home);
  expect(own.STITCHMUX_CONFIG).toBe('/srv/fleet/machine.json');
});

test('install moves the previous default boot labels to this release’s', () => {
  const { home } = legacyMachine();
  const file = join(home, '.config', 'ccmux', 'machine.json');
  expect(adoptNewBootLabels(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8')).bootLabel).toBe('com.stitchmux.daemon');
  expect(adoptNewBootLabels(file)).toBe(false);
});

test('the image decoder, run with an empty environment, neither waits for the move nor makes it', async () => {
  const { home, state } = legacyMachine();
  expect(await renameGate('_attachment-validate', gateDeps(home))).toBeNull();
  expect(existsSync(join(state, 'chat.jsonl'))).toBe(true);
  expect(existsSync(join(home, '.local', 'state', 'stitchmux'))).toBe(false);
});

test('the previous release’s command runs this installation, once that program exists', async () => {
  const { home } = legacyMachine();
  const previous = join(home, '.local', 'bin', 'ccmux');
  const program = join(home, '.local', 'share', 'stitchmux', 'app', 'stitchmux.js');
  // A machine without the previous command does not get one.
  expect(await bridgePreviousCommand(previous, '#!/bin/sh\nnew\n', program)).toBe(false);
  expect(existsSync(previous)).toBe(false);
  mkdirSync(dirname(previous), { recursive: true });
  writeFileSync(previous, '#!/bin/sh\nold\n');
  // Until the program is laid down the old command is left alone: it would point at nothing.
  expect(await bridgePreviousCommand(previous, '#!/bin/sh\nnew\n', program)).toBe(false);
  expect(readFileSync(previous, 'utf8')).toBe('#!/bin/sh\nold\n');
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, '');
  expect(await bridgePreviousCommand(previous, '#!/bin/sh\nnew\n', program)).toBe(true);
  expect(readFileSync(previous, 'utf8')).toBe('#!/bin/sh\nnew\n');
});
