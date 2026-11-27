import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSignedMacosBundle,
  findDeveloperId,
  installVerifiedBundle,
} from '../src/boot/macos/bundle.ts';
import { MACOS_LAUNCHER_C } from '../src/boot/macos/launcherSource.ts';
import {
  tmuxBootLabel,
  tmuxServerPid,
  usesManagedTmuxAgent,
  waitForManagedTmuxReady,
} from '../src/boot/macos/tmuxAgent.ts';
import { makeMachine } from './helpers.ts';

const work = mkdtempSync(join(tmpdir(), 'ccmux-macos-bundle-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('macOS bundle signing and atomic install contracts', () => {
  test('findDeveloperId extracts Developer ID Application SHA-1 and ignores Apple Development', () => {
    const sample = [
      '  1) DC7AA4A54301FFED44EE3A210B9E39D3A9093F74 "Apple Development: Example (AAA)"',
      '  2) 1BDDE0D75FA93E695F42F942ED1A07042D97AEBF "Developer ID Application: Example (BBB)"',
    ].join('\n');
    expect(findDeveloperId(() => sample)).toBe('1BDDE0D75FA93E695F42F942ED1A07042D97AEBF');
    expect(
      findDeveloperId(
        () => '  1) DC7AA4A54301FFED44EE3A210B9E39D3A9093F74 "Apple Development: Example (AAA)"',
      ),
    ).toBeNull();
  });

  test('buildSignedMacosBundle fails closed without Developer ID and refuses ad-hoc signing', () => {
    const missingIdTarget = join(work, 'Unsigned.app');
    expect(() => buildSignedMacosBundle(missingIdTarget, { identity: null })).toThrow(
      /fail-closed/,
    );
    expect(existsSync(missingIdTarget)).toBe(false);

    const adHocTarget = join(work, 'AdHoc.app');
    expect(() => buildSignedMacosBundle(adHocTarget, { identity: '-' })).toThrow(/ad-hoc/);
    expect(existsSync(adHocTarget)).toBe(false);
  });

  test('installVerifiedBundle swaps atomically and rolls back when post-swap verification fails', () => {
    const installed = join(work, 'Installed.app');
    const staged = join(work, 'Staged.app');
    mkdirSync(installed, { recursive: true });
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(installed, 'version.txt'), 'old');
    writeFileSync(join(staged, 'version.txt'), 'new');

    let calls = 0;
    const swap = (a: string, b: string) => {
      const aContent = readFileSync(join(a, 'version.txt'), 'utf8');
      const bContent = readFileSync(join(b, 'version.txt'), 'utf8');
      writeFileSync(join(a, 'version.txt'), bContent);
      writeFileSync(join(b, 'version.txt'), aContent);
    };
    expect(() =>
      installVerifiedBundle(
        staged,
        installed,
        () => {
          calls += 1;
          if (calls === 2) throw new Error('corrupted post-swap signature');
        },
        swap,
      ),
    ).toThrow(/corrupted post-swap signature/);

    expect(readFileSync(join(installed, 'version.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(staged, 'version.txt'), 'utf8')).toBe('new');
  });
});

describe('managed tmux LaunchAgent scope and startup race guard', () => {
  test('never enables managed tmux agent on Linux or on dev instances with custom tmuxSocket', () => {
    const prod = makeMachine({ bootLabel: 'com.ccmux.daemon' });
    const dev = makeMachine({ bootLabel: 'com.ccmux.daemon', tmuxSocket: 'ccmux-dev' });
    const explicit = makeMachine({
      bootLabel: 'com.ccmux.verify-daemon',
      tmuxBootLabel: 'com.ccmux.verify-tmux',
      tmuxSocket: 'ccmux-verify',
    });

    expect(tmuxBootLabel(prod)).toBe('com.ccmux.tmux');
    expect(tmuxBootLabel({ bootLabel: 'custom.unit' })).toBe('custom.unit.tmux');
    expect(usesManagedTmuxAgent(prod, 'linux')).toBe(false);
    expect(usesManagedTmuxAgent(prod, 'darwin')).toBe(true);
    expect(usesManagedTmuxAgent(dev, 'darwin')).toBe(false);
    expect(usesManagedTmuxAgent(explicit, 'darwin')).toBe(true);
  });

  test('waitForManagedTmuxReady waits for socket readiness and fails closed without spawning rogue tmux', async () => {
    const fakeHome = join(work, 'home-wait');
    mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(fakeHome, 'Library', 'LaunchAgents', 'com.ccmux.tmux.plist'), '<plist/>');
    const machine = makeMachine({ bootLabel: 'com.ccmux.daemon' });

    let checks = 0;
    const ready = await waitForManagedTmuxReady(machine, {
      home: fakeHome,
      platform: 'darwin',
      pollMs: 5,
      timeoutMs: 1_000,
      sleep: async () => {},
      checkPid: async () => {
        checks += 1;
        return checks >= 3 ? 4242 : null;
      },
    });
    expect(ready?.pid).toBe(4242);
    expect(checks).toBe(3);

    // Negative control: timeout refuses instead of returning silently to spawn a rogue tmux server.
    await expect(
      waitForManagedTmuxReady(machine, {
        home: fakeHome,
        platform: 'darwin',
        pollMs: 10,
        timeoutMs: 30,
        checkPid: async () => null,
      }),
    ).rejects.toThrow(/refusing to spawn an unmanaged tmux server/);

    // Dev instance with its own tmuxSocket is unaffected even when prod plist exists.
    const dev = makeMachine({ bootLabel: 'com.ccmux.daemon', tmuxSocket: 'ccmux-dev-iso' });
    expect(
      await waitForManagedTmuxReady(dev, {
        home: fakeHome,
        platform: 'darwin',
        checkPid: async () => null,
      }),
    ).toBeNull();
  });

  if (process.platform === 'darwin' && Bun.which('tmux') !== null) {
    test('waitForManagedTmuxReady connects to an asynchronously starting real tmux -D server', async () => {
      const tmuxBin = Bun.which('tmux') as string;
      const socket = `ccmux-race-${process.pid}-${Date.now()}`;
      const m = makeMachine({
        tmuxBin,
        tmuxSocket: socket,
        bootLabel: 'com.ccmux.race-daemon',
        tmuxBootLabel: 'com.ccmux.race-tmux',
      });
      const fakeHome = join(work, 'home-real-tmux');
      mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(
        join(fakeHome, 'Library', 'LaunchAgents', 'com.ccmux.race-tmux.plist'),
        '<plist/>',
      );

      let server: ReturnType<typeof Bun.spawn> | null = null;
      const starter = setTimeout(() => {
        server = Bun.spawn([tmuxBin, '-u', '-L', socket, '-D'], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
      }, 150);

      try {
        // Before server starts, tmuxServerPid returns null and must NOT auto-start a server.
        expect(await tmuxServerPid(m)).toBeNull();
        const result = await waitForManagedTmuxReady(m, {
          home: fakeHome,
          platform: 'darwin',
          pollMs: 25,
          timeoutMs: 5_000,
        });
        expect(result).not.toBeNull();
        expect(result?.pid).toBe((server as ReturnType<typeof Bun.spawn> | null)?.pid);
      } finally {
        clearTimeout(starter);
        Bun.spawnSync([tmuxBin, '-u', '-L', socket, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
      }
    });
  }
});

if (process.platform === 'darwin') {
  describe('ccmux-launcher C binary behavior', () => {
    const source = join(work, 'ccmux-launcher.c');
    const strictBinary = join(work, 'ccmux-launcher-strict');
    const testBinary = join(work, 'ccmux-launcher-test');
    writeFileSync(source, MACOS_LAUNCHER_C);
    const compiledStrict = Bun.spawnSync(
      ['clang', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', strictBinary],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const compiledTest = Bun.spawnSync(
      [
        'clang',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DCCMUX_LAUNCHER_ALLOW_NON_LAUNCHD',
        source,
        '-o',
        testBinary,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    test('production build fails closed (exit 125) on direct shell invocation when ppid != 1', () => {
      expect(compiledStrict.exitCode).toBe(0);
      const marker = join(work, 'strict-should-not-exist');
      const proc = Bun.spawnSync([strictBinary, '/usr/bin/touch', marker], { stderr: 'pipe' });
      expect(proc.exitCode).toBe(125);
      expect(proc.stderr.toString()).toContain('must be launched directly by launchd');
      expect(existsSync(marker)).toBe(false);
    });

    test('compiles cleanly with -Wall -Wextra -Werror and forwards args, env, and exit codes', () => {
      expect(compiledTest.exitCode).toBe(0);
      const usage = Bun.spawnSync([testBinary], { stderr: 'pipe' });
      expect(usage.exitCode).toBe(2);

      const ok = Bun.spawnSync(
        [testBinary, '/bin/sh', '-c', 'printf "%s:%s" "$CCMUX_PROBE" "$1"; exit 7', '--', 'val'],
        { env: { ...process.env, CCMUX_PROBE: 'hi' }, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(ok.exitCode).toBe(7);
      expect(ok.stdout.toString()).toBe('hi:val');

      const missing = Bun.spawnSync([testBinary, '/nonexistent/ccmux-launcher-target'], {
        stderr: 'pipe',
      });
      expect(missing.exitCode).toBe(127);
    });

    test('forwards SIGTERM to child and returns 128 + signal when child is killed by signal', async () => {
      const marker = join(work, 'sigterm-caught');
      const trapped = Bun.spawn(
        [
          testBinary,
          '/bin/sh',
          '-c',
          `trap 'echo caught > "${marker}"; exit 9' TERM; echo ready; while true; do sleep 0.1; done`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const reader = trapped.stdout.getReader();
      await reader.read();
      trapped.kill('SIGTERM');
      expect(await trapped.exited).toBe(9);
      expect(readFileSync(marker, 'utf8').trim()).toBe('caught');

      const signaled = Bun.spawn([testBinary, '/bin/sh', '-c', 'echo ready; exec sleep 30'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const reader2 = signaled.stdout.getReader();
      await reader2.read();
      signaled.kill('SIGTERM');
      expect(await signaled.exited).toBe(143);
    });
  });
}
