import { expect, test } from 'bun:test';
import { applyLaunchAgent, bootUnitNeedsWrite } from '../src/boot/install.ts';
import { shimContents } from '../src/boot/installedApp.ts';
import {
  launchdJobMatchesPlist,
  parseLaunchctlPrint,
  tmuxBootLabel,
} from '../src/boot/macos/tmuxAgent.ts';
import {
  type BootContext,
  renderLaunchdPlist,
  renderLaunchdTmuxPlist,
  renderSystemdUnit,
} from '../src/boot/render.ts';

const ctx: BootContext = {
  selfArgv: ['/usr/local/bin/ccmux'],
  label: 'ccmux.service',
  user: 'root',
  home: '/root',
  configPath: '/root/.config/ccmux/machine.json',
  pathEnv: '/root/.bun/bin:/usr/bin:/bin',
  logDir: '/var/log',
};

test('systemd unit: supervisor model, correct ExecStart, no ExecStop / no dangerous flag', () => {
  const u = renderSystemdUnit(ctx);
  expect(u).toContain('ExecStart=/usr/local/bin/ccmux daemon');
  expect(u).toContain('Type=simple');
  // `always`, not `on-failure`: 143 is declared a success, and on-failure would then leave the
  // daemon down after its own post-update bounce — the one restart it asks for by name.
  expect(u).toContain('Restart=always');
  expect(u).toContain('SuccessExitStatus=143');
  expect(u).toContain('User=root');
  expect(u).toContain('Environment="HOME=/root"');
  expect(u).toContain('Environment="CCMUX_CONFIG=/root/.config/ccmux/machine.json"');
  expect(u).toContain('Environment="PATH=/root/.bun/bin:/usr/bin:/bin"');
  expect(u).not.toContain('ExecStop'); // sessions outlive the daemon
  expect(u).not.toContain('dangerously');
  // Both halves of "the fleet survives what happens to the daemon", and they fail differently:
  // KillMode guards a deliberate stop, OOMPolicy guards a kernel OOM kill of anything in the
  // cgroup — every agent and everything an agent spawns. Under the default (`stop`) a browser a
  // session had opened was OOM-killed and systemd stopped the supervisor over it.
  expect(u).toContain('KillMode=process');
  expect(u).toContain('OOMPolicy=continue');
});

test('launchd plist: valid structure, KeepAlive SuccessfulExit false, daemon arg', () => {
  const mac: BootContext = {
    ...ctx,
    label: 'com.ccmux.daemon',
    home: '/Users/u',
    logDir: '/Users/u/Library/Logs',
    selfArgv: ['/Users/u/.local/bin/ccmux'],
  };
  const p = renderLaunchdPlist(mac);
  expect(p.startsWith('<?xml')).toBe(true);
  expect(p).toContain('<string>com.ccmux.daemon</string>');
  expect(p).toContain('<string>/Users/u/.local/bin/ccmux</string>');
  expect(p).toContain('<string>daemon</string>');
  expect(p).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
});

test('render is deterministic (install compares-then-writes relies on this)', () => {
  expect(renderSystemdUnit(ctx)).toBe(renderSystemdUnit(ctx));
  expect(renderLaunchdPlist(ctx)).toBe(renderLaunchdPlist(ctx));
});

test('bundle-mode selfArgv (bun + js) renders into ExecStart (P1-6: no hardcoded bun path)', () => {
  const bundle: BootContext = { ...ctx, selfArgv: ['/root/.bun/bin/bun', '/opt/ccmux/ccmux.js'] };
  expect(renderSystemdUnit(bundle)).toContain(
    'ExecStart=/root/.bun/bin/bun /opt/ccmux/ccmux.js daemon',
  );
});

test('systemd never stops restarting the supervisor, at a paced rate', () => {
  const u = renderSystemdUnit(ctx);
  // A start limit is terminal, and its budget is shared with every unit that Requires= this one:
  // a dependent's crash loop spent half of it while the daemon itself was failing on a stale lock.
  expect(u).toMatch(/^StartLimitIntervalSec=0$/m);
  expect(u).not.toMatch(/^StartLimitBurst=/m);
  expect(u).toMatch(/^Restart=always$/m);
  // Retrying forever is only affordable because each retry waits.
  expect(Number(/^RestartSec=(\d+)$/m.exec(u)?.[1])).toBeGreaterThanOrEqual(10);
});

test('the boot unit is rewritten when it differs, never created and never rewritten in place', () => {
  const rendered = renderSystemdUnit(ctx);

  // Not installed here: leave the machine alone. Installing is a deliberate act, and a daemon that
  // quietly writes a boot unit nobody asked for is worse than one that does nothing.
  expect(bootUnitNeedsWrite(null, rendered)).toBe(false);

  // Already current: no write, no reload. Convergence runs on every daemon start, so this is the
  // common case and it has to cost nothing.
  expect(bootUnitNeedsWrite(rendered, rendered)).toBe(false);

  // The shape that shipped before the restart policy was fixed. Without this a release rolls out
  // the code and leaves every installed machine on the definition that installed it, so the fix
  // ships to everyone and takes effect on nobody.
  const old = rendered
    .replace('Restart=always', 'Restart=on-failure')
    .replace('SuccessExitStatus=143\n', '');
  expect(bootUnitNeedsWrite(old, rendered)).toBe(true);
});

test('launchd plist wraps ProgramArguments with ccmux.app launcher only (never systemd or PATH shim)', () => {
  const launcher = '/Users/u/Applications/ccmux.app/Contents/MacOS/ccmux-launcher';
  const mac: BootContext = {
    ...ctx,
    label: 'com.ccmux.daemon',
    home: '/Users/u',
    logDir: '/Users/u/Library/Logs',
    selfArgv: ['/Users/u/.bun/bin/bun', '/Users/u/.local/share/ccmux/app/ccmux.js'],
    macosLauncher: launcher,
  };
  const plist = renderLaunchdPlist(mac);
  const idxLauncher = plist.indexOf(`<string>${launcher}</string>`);
  const idxBun = plist.indexOf('<string>/Users/u/.bun/bin/bun</string>');
  const idxBundle = plist.indexOf('<string>/Users/u/.local/share/ccmux/app/ccmux.js</string>');
  const idxDaemon = plist.indexOf('<string>daemon</string>');
  expect(idxLauncher).toBeGreaterThan(-1);
  expect(idxBun).toBeGreaterThan(idxLauncher);
  expect(idxBundle).toBeGreaterThan(idxBun);
  expect(idxDaemon).toBeGreaterThan(idxBundle);
  expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  // Linux systemd unit never uses the macOS launcher.
  expect(renderSystemdUnit(mac)).not.toContain('ccmux-launcher');
  // CLI PATH shim never wraps through ccmux-launcher.
  expect(shimContents()).not.toContain('ccmux-launcher');
});

test('launchd tmux plist runs tmux -u [-L socket] -D under ccmux.app with KeepAlive and ThrottleInterval', () => {
  const launcher = '/Users/u/Applications/ccmux.app/Contents/MacOS/ccmux-launcher';
  const prod = renderLaunchdTmuxPlist({
    label: tmuxBootLabel({ bootLabel: 'com.ccmux.daemon', tmuxBootLabel: undefined }),
    tmuxBin: '/opt/homebrew/bin/tmux',
    home: '/Users/u',
    configPath: '/Users/u/.config/ccmux/machine.json',
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    logDir: '/Users/u/Library/Logs',
    macosLauncher: launcher,
  });
  expect(prod).toContain('<string>com.ccmux.tmux</string>');
  expect(prod).toContain(`<string>${launcher}</string>`);
  expect(prod).toContain('<string>/opt/homebrew/bin/tmux</string>');
  expect(prod).toContain('<string>-u</string>');
  expect(prod).toContain('<string>-D</string>');
  expect(prod).not.toContain('<string>-L</string>');
  expect(prod).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  expect(prod).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  expect(prod.replace(/>\s+</g, '><')).toContain(
    '<key>CCMUX_CONFIG</key><string>/Users/u/.config/ccmux/machine.json</string>',
  );

  const scoped = renderLaunchdTmuxPlist({
    label: 'com.ccmux.custom.tmux',
    tmuxBin: '/opt/homebrew/bin/tmux',
    tmuxSocket: 'custom-sock',
    home: '/Users/u',
    configPath: '/Users/u/.config/ccmux/machine.json',
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    logDir: '/Users/u/Library/Logs',
    macosLauncher: launcher,
  });
  expect(scoped).toMatch(/<string>-L<\/string>\s*<string>custom-sock<\/string>/);
});

test('launchctl print parser detects plist migration mismatch and reloadLaunchdJob runs bootout + bootstrap', async () => {
  const loadedOld = parseLaunchctlPrint(`
gui/501/com.ccmux.daemon = {
\tstate = running
\tpid = 2346
\tprogram = /Users/u/.bun/bin/bun
\targuments = {
\t\t/Users/u/.bun/bin/bun
\t\t/Users/u/.local/share/ccmux/app/ccmux.js
\t\tdaemon
\t}
}
`);
  expect(loadedOld.running).toBe(true);
  expect(loadedOld.pid).toBe(2346);
  const newArgs = [
    '/Users/u/Applications/ccmux.app/Contents/MacOS/ccmux-launcher',
    '/Users/u/.bun/bin/bun',
    '/Users/u/.local/share/ccmux/app/ccmux.js',
    'daemon',
  ];
  expect(launchdJobMatchesPlist(loadedOld, newArgs)).toBe(false);
  expect(
    launchdJobMatchesPlist(loadedOld, [
      '/Users/u/.bun/bin/bun',
      '/Users/u/.local/share/ccmux/app/ccmux.js',
      'daemon',
    ]),
  ).toBe(true);

  const plist = '/test/agent.plist';
  const content = renderLaunchdPlist({ ...ctx, label: 'com.example.daemon' });
  const calls: string[] = [];
  let active = true;
  let now = 0;
  await applyLaunchAgent('com.example.daemon', plist, content, '/usr/local/bin/ccmux', {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    canonicalPath: async (p) => p,
    inspectPath: async () => ({ kind: 'file', mode: 0o644 }),
    readFile: async () => new TextEncoder().encode(content),
    writeFileAtomic: async () => {},
    removeFile: async () => {},
    runCommand: async (_, args) => {
      const verb = args[0];
      if (!verb) throw new Error('missing command');
      calls.push(verb);
      if (verb === 'bootout') active = false;
      if (verb === 'bootstrap') active = true;
      return {
        exitCode: verb === 'print' && !active ? 113 : 0,
        stdout: `gui/501/com.example.daemon = {\n\tpath = ${plist}\n\tstate = running\n\tprogram = ${ctx.selfArgv[0]}\n\tpid = 23\n}\n`,
        stderr: '',
      };
    },
  });
  expect(calls.filter((v) => v !== 'print')).toEqual(['enable', '-lint', 'bootout', 'bootstrap']);
  expect(now).toBeGreaterThanOrEqual(5000);
});
