import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineConfigSchema } from '../src/config/machineSchema.ts';

// The TUI's way out on a real pseudo-terminal. A closing terminal tab can hand the foreground back to
// the shell before the hangup reaches the TUI; if the exit path then touches the tty (switching raw
// mode off is a `tcsetattr`, and Ink's own exit hook does it too), the kernel stops the process with
// SIGTTOU and it never exits. The harness reproduces that order: the TUI runs in the foreground of
// its own pty, the session leader takes the foreground back, signals the TUI and reports, within one
// second, whether it exited or was stopped. The control is a three-line program that does the same
// unprotected restore: it must STOP, which proves the harness really puts the process in the
// background — without it, "exited" could mean the harness never reproduced anything.

const HARNESS = `
import os, pty, sys, time, signal, json, select
argv, out, sig = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
ready = out + '.ready'
pid, fd = pty.fork()
if pid == 0:
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)   # the leader itself calls tcsetpgrp from the background
    tui = os.fork()
    if tui == 0:
        signal.signal(signal.SIGTTOU, signal.SIG_DFL)  # an ignored signal survives exec; the TUI must not inherit it
        os.setpgid(0, 0)
        while os.tcgetpgrp(0) != os.getpgrp():
            time.sleep(0.01)
        os.execvp(argv[0], argv)
    os.setpgid(tui, tui)
    os.tcsetpgrp(0, tui)
    deadline = time.time() + 30
    while not os.path.exists(ready) and time.time() < deadline:
        time.sleep(0.05)
    import termios
    raw = False
    while time.time() < deadline:                   # Ink switches the tty to raw mode once it renders
        if not termios.tcgetattr(0)[3] & termios.ICANON:
            raw = True
            break
        time.sleep(0.05)
    if not raw:
        with open(out, 'w') as f:
            f.write('never raw')
        os.kill(tui, signal.SIGKILL)
        os._exit(0)
    os.tcsetpgrp(0, os.getpgrp())                   # the TUI is now a background process group
    os.kill(tui, getattr(signal, sig))
    result = 'alive'
    end = time.time() + 1
    while time.time() < end:
        w, status = os.waitpid(tui, os.WNOHANG | os.WUNTRACED)
        if w == tui:
            if os.WIFSTOPPED(status):
                result = 'stopped:' + signal.Signals(os.WSTOPSIG(status)).name
            else:
                result = 'exited'
            break
        time.sleep(0.02)
    if result != 'exited':
        os.kill(tui, signal.SIGKILL)
    with open(out, 'w') as f:
        f.write(result)
    os._exit(0)
seen = 0
while True:
    try:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            data = os.read(fd, 65536)
            if not data:
                break
            seen += len(data)
            if seen > 0 and not os.path.exists(ready):
                open(ready, 'w').close()
    except OSError:
        break
    w, _ = os.waitpid(pid, os.WNOHANG)
    if w == pid:
        break
`;

function world(): { env: Record<string, string>; out: string; harness: string } {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-tui-death-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  const tmux = join(root, 'tmux');
  writeFileSync(tmux, '#!/bin/sh\nexit 1\n');
  chmodSync(tmux, 0o755);
  const config = join(root, 'machine.json');
  writeFileSync(
    config,
    JSON.stringify(
      MachineConfigSchema.parse({
        claudeBin: '/bin/false',
        tmuxBin: tmux,
        projectsDir: join(root, 'projects'),
        rcPrefix: 'host-a',
        stateDir,
        bootLabel: 'ccmux.service',
      }),
    ),
  );
  const harness = join(root, 'harness.py');
  writeFileSync(harness, HARNESS);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = config;
  env.CCMUX_STATE_DIR = stateDir;
  env.HOME = root;
  env.TERM = 'xterm-256color';
  delete env.TMUX;
  return { env, out: join(root, 'result'), harness };
}

async function signalFromBackground(argv: string[], signal: 'SIGHUP' | 'SIGTERM'): Promise<string> {
  const w = world();
  const proc = Bun.spawn(['python3', w.harness, JSON.stringify(argv), w.out, signal], {
    env: w.env,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  await proc.exited;
  return existsSync(w.out) ? readFileSync(w.out, 'utf8') : 'no result';
}

const TUI = [
  process.execPath,
  '--no-env-file',
  join(import.meta.dir, '..', 'src', 'cli.ts'),
  'tui',
];

test('a hangup while the TUI is in the background exits it within a second', async () => {
  expect(await signalFromBackground(TUI, 'SIGHUP')).toBe('exited');
}, 60_000);

test('so does a SIGTERM, whose path restores the terminal first', async () => {
  expect(await signalFromBackground(TUI, 'SIGTERM')).toBe('exited');
}, 60_000);

test('control: an unprotected raw-mode restore from the background is stopped by SIGTTOU', async () => {
  const program = [
    'process.stdin.setRawMode(true);',
    "process.stdout.write('ready');",
    "process.on('SIGHUP', () => { process.stdin.setRawMode(false); process.exit(0); });",
    'setInterval(() => {}, 1000);',
  ].join(' ');
  const argv = [process.execPath, '--no-env-file', '-e', program];
  expect(await signalFromBackground(argv, 'SIGHUP')).toBe('stopped:SIGTTOU');
}, 60_000);
