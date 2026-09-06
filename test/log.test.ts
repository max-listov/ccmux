import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh process resolves the real logger's state path before any module can cache it.
// Changing an environment variable around a cached dynamic import cannot isolate filesystem IO.
const sandbox = mkdtempSync(join(tmpdir(), 'ccmux-log-'));
// Asked of the logger rather than guessed. This file used to carry its own copy of the naming rule
// — `join(sandbox, 'ccmux.log')` — and the day the product started separating a checkout's record
// from the machine's, five tests failed on a second copy of a fact that had exactly one owner. The
// subject here is thresholds, format and rotation; where the file is belongs to the logger.
const LOG_FILE = logFilePath();
let threshold = 'info';
const setLogLevel = (level: string) => {
  threshold = level;
};
function emit(level: string, fields: Record<string, unknown>): void {
  emitScript('log[process.env.CCMUX_TEST_METHOD](JSON.parse(process.env.CCMUX_TEST_FIELDS));', {
    CCMUX_TEST_METHOD: level,
    CCMUX_TEST_FIELDS: JSON.stringify(fields),
  });
}

function emitScript(script: string, env: Record<string, string> = {}): void {
  const child = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      [
        'const { log, setLogLevel, LOG_FILE } = await import(process.env.CCMUX_TEST_LOGGER);',
        'setLogLevel(process.env.CCMUX_TEST_LEVEL);',
        script,
        'console.log(LOG_FILE);',
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        CCMUX_STATE_DIR: sandbox,
        CCMUX_TEST_LOGGER: new URL('../src/util/log.ts', import.meta.url).href,
        CCMUX_TEST_LEVEL: threshold,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  expect(child.exitCode).toBe(0);
  // Still checked, because a child writing somewhere else would make every assertion below read a
  // file nobody wrote — and an empty read is indistinguishable from a threshold that dropped it.
  expect(child.stdout.toString().trim()).toBe(LOG_FILE);
}

/** Where the logger writes, under this sandbox — from the logger itself, in a child that resolves
 *  it the same way every other run does. */
function logFilePath(): string {
  const child = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      [
        'const { LOG_FILE } = await import(process.env.CCMUX_TEST_LOGGER);',
        'console.log(LOG_FILE);',
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        CCMUX_STATE_DIR: sandbox,
        CCMUX_TEST_LOGGER: new URL('../src/util/log.ts', import.meta.url).href,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const path = child.stdout.toString().trim();
  if (child.exitCode !== 0 || !path.startsWith(sandbox))
    throw new Error(
      `logger did not report a path under the sandbox: ${path || child.stderr.toString()}`,
    );
  return path;
}
const log = {
  debug: (fields: Record<string, unknown>) => emit('debug', fields),
  info: (fields: Record<string, unknown>) => emit('info', fields),
  warn: (fields: Record<string, unknown>) => emit('warn', fields),
  error: (fields: Record<string, unknown>) => emit('error', fields),
};
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function reset(): void {
  rmSync(LOG_FILE, { force: true });
  for (const i of [1, 2, 3]) rmSync(`${LOG_FILE}.${i}`, { force: true });
  setLogLevel('info');
}

beforeEach(reset);

test('threshold drops below-level events, keeps at/above', () => {
  setLogLevel('warn');
  log.debug({ msg: 'd' });
  log.info({ msg: 'i' });
  log.warn({ msg: 'w' });
  log.error({ msg: 'e' });
  const body = readFileSync(LOG_FILE, 'utf8');
  expect(body).not.toContain('"msg":"d"');
  expect(body).not.toContain('"msg":"i"');
  expect(body).toContain('"msg":"w"');
  expect(body).toContain('"msg":"e"');
});

test('debug level lets everything through', () => {
  setLogLevel('debug');
  log.debug({ msg: 'dbg' });
  expect(readFileSync(LOG_FILE, 'utf8')).toContain('"msg":"dbg"');
});

test('one JSON object per line with ts/pid/level/msg', () => {
  log.info({ msg: 'hello', extra: 7 });
  const line = readFileSync(LOG_FILE, 'utf8').trim().split('\n').at(-1) ?? '';
  const obj = JSON.parse(line);
  expect(obj.msg).toBe('hello');
  expect(obj.extra).toBe(7);
  expect(obj.level).toBe('info');
  expect(typeof obj.ts).toBe('string');
  expect(typeof obj.pid).toBe('number');
});

test('rotation shifts LOG_FILE → .1 when it exceeds the size cap', () => {
  // Pre-fill the live file past the 5MB cap, then one write triggers the rotate.
  writeFileSync(LOG_FILE, 'x'.repeat(6 * 1024 * 1024));
  log.info({ msg: 'after-rotate' });
  expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
  expect(statSync(`${LOG_FILE}.1`).size).toBeGreaterThan(5 * 1024 * 1024); // old big file moved aside
  const live = readFileSync(LOG_FILE, 'utf8');
  expect(live).toContain('"msg":"after-rotate"'); // new small live file
  expect(live.length).toBeLessThan(1024);
});

test('rotation caps generations at .2 (no unbounded growth)', () => {
  for (let gen = 0; gen < 4; gen++) {
    writeFileSync(LOG_FILE, 'x'.repeat(6 * 1024 * 1024));
    log.info({ msg: `gen${gen}` });
  }
  expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
  expect(existsSync(`${LOG_FILE}.2`)).toBe(true);
  expect(existsSync(`${LOG_FILE}.3`)).toBe(false); // KEEP=2 — never a third rotated file
});

test('the real log sink redacts nested credentials and retains useful diagnostic fields', () => {
  log.error({
    msg: 'request failed',
    status: 503,
    nested: { token: 'synthetic-token', CCMUX_CHAT_CREDENTIAL: 'synthetic-capability' },
    apiKey: 'synthetic-key',
    url: 'https://example.com/resource?token=synthetic-query',
  });
  const body = readFileSync(LOG_FILE, 'utf8');
  for (const secret of [
    'synthetic-token',
    'synthetic-capability',
    'synthetic-key',
    'synthetic-query',
  ])
    expect(body).not.toContain(secret);
  expect(body).toContain('"status":503');
  expect(body).toContain('request failed');
});

test('cycles, BigInt and Error values cannot throw from logging', () => {
  emitScript(`
    const circular = { count: 123n }; circular.self = circular;
    log.error({ msg: 'safe failure', circular, err: new Error('diagnostic reason') });
  `);
  const body = readFileSync(LOG_FILE, 'utf8');
  expect(body).toContain('safe failure');
  expect(body).toContain('diagnostic reason');
  expect(body.trim().split('\n')).toHaveLength(1);
});

test('one adversarial log entry stays within 16 KiB including its sink envelope', () => {
  emitScript(
    "log.info({ msg: 'wide entry', values: Array.from({ length: 100 }, () => '😀'.repeat(4000)) });",
  );
  const body = readFileSync(LOG_FILE, 'utf8');
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024);
  expect(body).toContain('truncated');
});

test('caller fields cannot forge the sink identity and stderr failure cannot escape', () => {
  log.info({ msg: 'real identity', level: 'error', pid: -1, ts: 'fake-time', src: 'fake-source' });
  const body = readFileSync(LOG_FILE, 'utf8');
  expect(body).toContain('"level":"info"');
  expect(body).not.toContain('"pid":-1');
  expect(body).not.toContain('fake-time');
  expect(body).not.toContain('fake-source');
  emitScript(`
    process.stderr.write = () => { throw new Error('closed stderr'); };
    log.info({ msg: 'file survived stderr' });
  `);
  expect(readFileSync(LOG_FILE, 'utf8')).toContain('file survived stderr');
});
