import { expect, test } from 'bun:test';
import { bootUnitNeedsWrite } from '../src/boot/install.ts';
import { type BootContext, renderLaunchdPlist, renderSystemdUnit } from '../src/boot/render.ts';

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
  expect(u).toContain('Environment=HOME=/root');
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
  expect(p).toContain('<key>SuccessfulExit</key><false/>');
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
