import { afterEach, expect, test } from 'bun:test';
import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppUnavailable, connectCodexSocket } from '../src/agent/codex/socket.ts';
import { ExternalSessionSchema } from '../src/config/schema.ts';
import { unknownTurnState } from '../src/external/turnSchema.ts';
import { observeExternalTurns, reasonFor } from '../src/external/turnState.ts';
import { makeMachine, UUID } from './helpers.ts';

// Why this file exists, and why it uses a REAL socket rather than a fake connector.
//
// Fifty external threads reported one reason — `connection-unavailable` — while the app was open
// and being typed into. The reason named a state of the wire, so nobody could act on it, and the
// two cases a reader most needs apart were the same word: "the app never created the endpoint" and
// "the app created it and its server is gone".
//
// The obvious classifier is the errno, and it does not work here: measured on this runtime,
// `net.createConnection` answers ENOENT for BOTH a missing path and a socket whose listener has
// exited — while a direct syscall to that same socket answers ECONNREFUSED. A fake connector would
// have hidden that completely, which is why every case below drives the real one.

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'ccmux-endpoint-'));
  roots.push(path);
  return path;
}

async function kindOf(path: string): Promise<string> {
  try {
    const rpc = await connectCodexSocket(path, { maxMessageBytes: 1024 });
    rpc.close();
    return 'connected';
  } catch (error) {
    return error instanceof CodexAppUnavailable ? error.kind : `other: ${String(error)}`;
  }
}

test('the runtime cannot tell the two outages apart, so the connector does not ask it to', async () => {
  const dir = root();
  const missing = join(dir, 'absent.sock');
  const stale = join(dir, 'stale.sock');
  const live = join(dir, 'live.sock');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(live, resolve));
  // A hard link keeps the socket inode after the server unlinks its own path: a real stale
  // endpoint, exactly the shape a crashed app leaves behind — not a regular file standing in for one.
  linkSync(live, stale);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const errno = await new Promise<string>((resolve) => {
    const probe = net.createConnection(stale);
    probe.on('connect', () => {
      probe.destroy();
      resolve('connected');
    });
    probe.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
  });
  const missingErrno = await new Promise<string>((resolve) => {
    const probe = net.createConnection(missing);
    probe.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
  });
  // The measurement this whole design rests on: identical errno, opposite meanings.
  expect(errno).toBe(missingErrno);

  expect(await kindOf(missing)).toBe('endpoint-absent');
  expect(await kindOf(stale)).toBe('endpoint-not-listening');
});

test('an endpoint that answers but refuses the upgrade is its own cause', async () => {
  const dir = root();
  const path = join(dir, 'wrong.sock');
  const server = net.createServer((socket) => {
    socket.on('data', () => socket.end('HTTP/1.1 404 Not Found\r\n\r\n'));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    expect(await kindOf(path)).toBe('upgrade-refused');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a path that is not a socket at all is still not reported as "never created"', async () => {
  const dir = root();
  const path = join(dir, 'regular-file');
  writeFileSync(path, 'not a socket');
  // It exists, so the honest statement is that connecting to it failed — not that the app never
  // made it. Getting this backwards would send a person to start an app that is already running.
  expect(await kindOf(path)).toBe('endpoint-not-listening');
});

const row = (id = UUID) =>
  ExternalSessionSchema.parse({
    key: `external:codex:host-a#${id}`,
    plane: 'external',
    provider: 'codex',
    host: 'host-a',
    threadId: id,
    dir: null,
    path: null,
    origin: 'app-server',
    storage: 'missing',
    writerEvidence: 'none-observed',
    writerRuntime: null,
    turnState: unknownTurnState('codex-app-server'),
    capabilities: {
      inspect: false,
      attemptAdopt: false,
      fork: false,
      terminateAndAdopt: false,
      releaseAtSource: false,
      reasons: [],
    },
    lastActivityMs: null,
    lastModel: null,
    usedTokens: null,
    lastMessage: null,
  });

test('every outage reaches the consumer with a cause AND something a person can do', async () => {
  for (const kind of [
    'endpoint-absent',
    'endpoint-not-listening',
    'upgrade-refused',
    'connection-lost',
  ] as const) {
    const [session] = await observeExternalTurns(makeMachine(), [row()], async () => {
      throw new CodexAppUnavailable(kind, 'synthetic');
    });
    expect(session?.turnState.reason).toBe(kind);
    expect(session?.turnState.remedy).toMatch(/\S/);
    expect(session?.turnState.state).toBe('unknown');
    expect(session?.turnState.evidence).toBe('unavailable');
  }
});

test('a failure this build cannot name says so, and says how to find out', async () => {
  // The alternative is worse than a vague name: borrowing a specific one would send a reader to
  // fix an endpoint that was reached successfully and failed somewhere else entirely.
  expect(reasonFor(new Error('thread/list exploded'))).toBe('connection-unavailable');
  const [session] = await observeExternalTurns(makeMachine(), [row()], async () => {
    throw new Error('thread/list exploded');
  });
  expect(session?.turnState.reason).toBe('connection-unavailable');
  expect(session?.turnState.remedy).toContain('by hand');
});
