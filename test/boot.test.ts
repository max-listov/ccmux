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

test('the start limit survives the restart burst that actually killed two machines', () => {
  const u = renderSystemdUnit(ctx);
  const value = (key: string) => {
    const found = new RegExp(`^${key}=(\\d+)$`, 'm').exec(u)?.[1];
    if (found === undefined) throw new Error(`unit does not set ${key}`);
    return Number(found);
  };
  const windowSec = value('StartLimitIntervalSec');
  const burst = value('StartLimitBurst');
  const delaySec = value('RestartSec');

  // Measured, not imagined: an update bounce landed alongside an unrelated systemd re-exec and
  // produced six starts inside thirty-five seconds. The budget was five per minute, so the sixth
  // exhausted it — and a tripped start limit is TERMINAL. systemd stops trying, the unit stays
  // failed, and the supervisor is dead until a person happens to look. Both machines sat that way
  // for two hours. A burst that is not a crash-loop must not be able to spend the whole budget.
  const INCIDENT_STARTS = 6;
  const INCIDENT_SECONDS = 35;
  expect(INCIDENT_SECONDS).toBeLessThan(windowSec); // the burst falls inside one window
  expect(INCIDENT_STARTS).toBeLessThan(burst);

  // And a real crash-loop must still trip it: a process that dies at once restarts every
  // RestartSec, so the whole budget has to be spendable inside the window.
  expect(burst * delaySec).toBeLessThan(windowSec);
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
