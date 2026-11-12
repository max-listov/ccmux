import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';
import { APP_BUNDLE, LOG_FILE } from '../src/config/paths.ts';
import { autoUpdateOnce, releaseSettled } from '../src/release/update.ts';

const MINUTE = 60_000;
const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('an unattended update waits until the release is as old as the settle time', () => {
  expect(releaseSettled(ago(3 * MINUTE), 600, NOW)).toBe(false);
  expect(releaseSettled(ago(10 * MINUTE - 1), 600, NOW)).toBe(false);
  expect(releaseSettled(ago(10 * MINUTE), 600, NOW)).toBe(true);
  expect(releaseSettled(ago(3 * MINUTE), 0, NOW)).toBe(true);
});

test('a release that does not say when it was cut is not held', () => {
  expect(releaseSettled(undefined, 600, NOW)).toBe(true);
  expect(releaseSettled('not a time', 600, NOW)).toBe(true);
});

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  rmSync(APP_BUNDLE, { force: true });
});

/** An installed bundle: without one the daemon is restoring, not updating. */
function installed(): void {
  mkdirSync(dirname(APP_BUNDLE), { recursive: true });
  writeFileSync(APP_BUNDLE, '// installed\n');
}

/** A feed with one newer release cut `ageMs` ago; counts how often its bundle is asked for. */
function feed(ageMs: number) {
  const seen = { bundle: 0 };
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname, origin } = new URL(request.url);
      if (pathname === '/ccmux.js') {
        seen.bundle += 1;
        return new Response('not a bundle');
      }
      return Response.json({
        version: '999.0.0',
        sha256: 'a'.repeat(64),
        url: `${origin}/ccmux.js`,
        releasedAt: new Date(Date.now() - ageMs).toISOString(),
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/release.json`, seen };
}

const machine = (releaseUrl: string) =>
  MachineConfigSchema.parse({
    claudeBin: '/bin/true',
    tmuxBin: '/bin/true',
    projectsDir: '/tmp',
    rcPrefix: 'host-a',
    stateDir: process.env.CCMUX_STATE_DIR,
    bootLabel: 'ccmux-test.service',
    releaseUrl,
    autoUpdate: true,
  });

const logged = (from: number) => readFileSync(LOG_FILE, 'utf8').slice(from);
const logSize = () => {
  try {
    return readFileSync(LOG_FILE, 'utf8').length;
  } catch {
    return 0;
  }
};

test('the daemon leaves a release cut a minute ago alone and says it is waiting', async () => {
  installed();
  const { url } = feed(MINUTE);
  const from = logSize();
  expect(await autoUpdateOnce(machine(url))).toBe(false);
  const lines = logged(from);
  expect(lines).toContain('auto-update waits for the release to settle');
  expect(lines).not.toContain('auto-update seen');
});

test('the daemon goes on to take a release older than the settle time', async () => {
  installed();
  const { url } = feed(11 * MINUTE);
  const from = logSize();
  // The feed's release is unsigned, so the take is refused at the signature — after the decision
  // this test is about: the release was seen and acted on, not held.
  expect(await autoUpdateOnce(machine(url))).toBe(false);
  const lines = logged(from);
  expect(lines).toContain('auto-update seen');
  expect(lines).not.toContain('auto-update waits for the release to settle');
});

test('a bundle missing from disk is restored without waiting for the release to settle', async () => {
  const { url } = feed(MINUTE);
  const from = logSize();
  expect(await autoUpdateOnce(machine(url))).toBe(false);
  const lines = logged(from);
  expect(lines).toContain('bundle missing from disk');
  expect(lines).not.toContain('auto-update waits for the release to settle');
});
