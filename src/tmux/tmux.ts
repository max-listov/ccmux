import { clearStatus } from '../agent/sessionStatus.ts';
import type { MachineConfig } from '../types.ts';
import { run, runWithInput } from '../util/spawn.ts';
import { exactTarget, paneTarget } from './target.ts';

// Typed tmux wrappers — every call is an argv array via util/spawn. All targeting
// goes through target.ts; no bare `-t name` anywhere.

/** Base tmux argv, scoped to the config's optional dedicated socket (`-L`). EVERY tmux invocation
 *  goes through this, so an isolated instance (dev) is fully confined to its own tmux server. Unset
 *  socket → the default socket (prod), i.e. current behaviour. Exported for the test. */
export function tmuxArgv(m: MachineConfig, ...args: string[]): string[] {
  return m.tmuxSocket ? [m.tmuxBin, '-L', m.tmuxSocket, ...args] : [m.tmuxBin, ...args];
}

export async function hasSession(m: MachineConfig, name: string): Promise<boolean> {
  const { code } = await run(tmuxArgv(m, 'has-session', '-t', exactTarget(name)));
  return code === 0;
}

/** One fork per tick instead of N has-session calls (P3-15). */
export async function listSessionNames(m: MachineConfig): Promise<Set<string>> {
  const { code, stdout } = await run(tmuxArgv(m, 'list-sessions', '-F', '#{session_name}'));
  if (code !== 0) return new Set();
  return new Set(
    stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  );
}

/** name → session_created (epoch seconds) for every live session — one fork, for `list`
 *  uptime. Parses the trailing epoch so session names containing spaces still work. */
export async function listSessionsCreated(m: MachineConfig): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { code, stdout } = await run(
    tmuxArgv(m, 'list-sessions', '-F', '#{session_name} #{session_created}'),
  );
  if (code !== 0) return out;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const sp = trimmed.lastIndexOf(' ');
    if (sp === -1) continue;
    const created = Number.parseInt(trimmed.slice(sp + 1), 10);
    if (!Number.isNaN(created)) out.set(trimmed.slice(0, sp), created);
  }
  return out;
}

// ccmux's own env that pins WHICH instance a pane belongs to. tmux does NOT propagate arbitrary
// env vars into a new session's panes (even on a dedicated socket), so we pass them EXPLICITLY via
// `new-session -e` — otherwise a `_run` pane in an isolated (dev) instance reads the prod config and
// dies. Prod sets none of these (uses defaults) → nothing is passed, behaviour unchanged.
const INSTANCE_ENV_KEYS = ['CCMUX_STATE_DIR', 'CCMUX_CACHE_DIR', 'CCMUX_CONFIG'] as const;

function instanceEnvArgs(): string[] {
  const out: string[] = [];
  for (const key of INSTANCE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined && v !== '') out.push('-e', `${key}=${v}`);
  }
  return out;
}

export async function newSession(
  m: MachineConfig,
  name: string,
  dir: string,
  cmd: string[],
  extraEnv: Record<string, string> = {},
): Promise<void> {
  // `-s NAME` (plain, for creation), `-e` pins the instance env into the pane (see above), `--` so
  // tmux treats the rest as command tokens.
  const envArgs = [...instanceEnvArgs()];
  for (const [key, value] of Object.entries(extraEnv)) envArgs.push('-e', `${key}=${value}`);
  const result = await run(
    tmuxArgv(m, 'new-session', '-d', '-s', name, '-c', dir, ...envArgs, '--', ...cmd),
  );
  if (result.code !== 0)
    throw new Error(
      `tmux could not create '${name}': ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

export async function killSessionIfGeneration(
  m: MachineConfig,
  name: string,
  generation: string,
): Promise<boolean> {
  const result = await run(
    tmuxArgv(m, 'show-environment', '-t', exactTarget(name), 'CCMUX_BOOTSTRAP_GENERATION'),
  );
  if (result.code !== 0 || result.stdout.trim() !== `CCMUX_BOOTSTRAP_GENERATION=${generation}`)
    return false;
  return killSession(m, name);
}

export async function killSession(m: MachineConfig, name: string): Promise<boolean> {
  const pane = await run(
    tmuxArgv(m, 'display-message', '-p', '-t', paneTarget(name), '#{pane_pid}'),
  );
  const panePid = Number.parseInt(pane.stdout.trim(), 10);
  let processGroup: number | null = null;
  if (pane.code === 0 && Number.isInteger(panePid) && panePid > 1) {
    const pg = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(panePid)], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const value = Number.parseInt(pg.stdout.toString().trim(), 10);
    if (pg.exitCode === 0 && Number.isInteger(value) && value > 1) processGroup = value;
  }
  const { code } = await run(tmuxArgv(m, 'kill-session', '-t', exactTarget(name)));
  // Single funnel for stop/rm/restart (CLI + TUI) — drop the session's structured status files so a
  // stopped/removed session never shows a stale live state; a restart re-writes them via SessionStart.
  clearStatus(name);
  if (code === 0 && processGroup !== null) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const ps = Bun.spawnSync(['ps', '-axo', 'pgid='], { stdout: 'pipe', stderr: 'ignore' });
      const alive =
        ps.exitCode === 0 &&
        ps.stdout
          .toString()
          .split('\n')
          .some((line) => Number.parseInt(line.trim(), 10) === processGroup);
      if (!alive) return true;
      await Bun.sleep(50);
    }
    throw new Error(`managed process group ${processGroup} did not exit after stopping ${name}`);
  }
  return code === 0;
}

export async function setOption(
  m: MachineConfig,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run(tmuxArgv(m, 'set-option', '-t', exactTarget(name), key, value)); // best-effort
}

/** Pane-scoped option on the session's single pane (e.g. allow-passthrough) — kept
 *  session-local so ccmux never mutates the shared tmux server's global options. */
export async function setPaneOption(
  m: MachineConfig,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run(tmuxArgv(m, 'set-option', '-p', '-t', paneTarget(name), key, value)); // best-effort
}

/** Literal text (`-l`) — for sending user/prompt text. */
export async function sendKeysLiteral(
  m: MachineConfig,
  name: string,
  text: string,
): Promise<boolean> {
  // `--` so a payload starting with "-" is treated as literal text, not a tmux flag
  const { code } = await run(tmuxArgv(m, 'send-keys', '-t', paneTarget(name), '-l', '--', text));
  return code === 0;
}

/** Named keys (NO `-l`) — Enter/Up/Escape/C-c (P3-13: distinct from literal). */
/** Returns whether tmux accepted the key — a dead pane reports failure, and a caller that submits a
 *  message needs to know its Enter never landed rather than record a delivery that did not happen. */
export async function sendKeysNamed(m: MachineConfig, name: string, key: string): Promise<boolean> {
  const { code } = await run(tmuxArgv(m, 'send-keys', '-t', paneTarget(name), key));
  return code === 0;
}

/** Insert `text` into the pane as a BRACKETED paste (so a multi-line block goes in as one unit
 *  that does NOT submit — the caller sends Enter). Payload rides stdin via `load-buffer -` (no
 *  argv length limit / escaping); `-d` drops the buffer after. Returns false if either step fails. */
export async function pasteText(m: MachineConfig, name: string, text: string): Promise<boolean> {
  const loaded = await runWithInput(tmuxArgv(m, 'load-buffer', '-b', 'ccmux-chat', '-'), text);
  if (loaded.code !== 0) return false;
  const { code } = await run(
    tmuxArgv(m, 'paste-buffer', '-p', '-d', '-b', 'ccmux-chat', '-t', paneTarget(name)),
  );
  return code === 0;
}

/**
 * Load one private paste buffer for a chat delivery attempt. The random name prevents concurrent
 * recipients from replacing each other's payload while the daemon is fanning out a pass.
 */
export async function loadPasteBuffer(m: MachineConfig, text: string): Promise<string | null> {
  const buffer = `ccmux-chat-${crypto.randomUUID()}`;
  const loaded = await runWithInput(tmuxArgv(m, 'load-buffer', '-b', buffer, '-'), text);
  return loaded.code === 0 ? buffer : null;
}

/** Stop/start client input to one pane. While disabled, tmux also blocks programmatic send-keys. */
export async function setPaneInputEnabled(
  m: MachineConfig,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  const { code } = await run(
    tmuxArgv(m, 'select-pane', enabled ? '-e' : '-d', '-t', paneTarget(name)),
  );
  return code === 0;
}

/**
 * Re-enable input, bracket-paste one already-loaded buffer, and submit it in ONE tmux command queue.
 * None of these commands yields, so a client key cannot interleave between re-enable, paste and
 * Enter. Callers must first disable input and classify the pane while that gate is held.
 */
export async function submitPasteBuffer(
  m: MachineConfig,
  name: string,
  buffer: string,
  messageId: string,
): Promise<boolean> {
  const target = paneTarget(name);
  const { code } = await run(
    tmuxArgv(
      m,
      'select-pane',
      '-e',
      '-t',
      target,
      ';',
      'paste-buffer',
      '-p',
      '-d',
      '-b',
      buffer,
      '-t',
      target,
      ';',
      'send-keys',
      '-t',
      target,
      'Enter',
      ';',
      'set-option',
      '-p',
      '-t',
      target,
      '@ccmux-chat-submitted',
      messageId,
    ),
  );
  return code === 0;
}

/** Last chat id whose paste+Enter command queue completed on this pane. */
export async function submittedChatId(m: MachineConfig, name: string): Promise<string | null> {
  const { code, stdout } = await run(
    tmuxArgv(m, 'show-options', '-p', '-v', '-t', paneTarget(name), '@ccmux-chat-submitted'),
  );
  return code === 0 && stdout.trim() !== '' ? stdout.trim() : null;
}

export async function deletePasteBuffer(m: MachineConfig, buffer: string): Promise<void> {
  await run(tmuxArgv(m, 'delete-buffer', '-b', buffer));
}

export async function capturePane(m: MachineConfig, name: string, lines: number): Promise<string> {
  const { stdout } = await run(
    tmuxArgv(m, 'capture-pane', '-t', paneTarget(name), '-p', '-S', `-${lines}`),
  );
  return stdout;
}

/** Every ANSI colour/attribute sequence — for turning a styled capture back into plain text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal SGR sequences are intentionally matched by ESC byte.
const ANSI_RE = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

/**
 * The same capture, but KEEPING colour and attribute sequences (`-e`).
 *
 * Needed because some things on screen are only distinguishable by how they are DRAWN: Claude renders
 * its autosuggestion in the composer dim, exactly where a human's typed text would be, and read as
 * plain text the two are identical. That ambiguity held a session's chat indefinitely while the hold
 * note blamed a human who was not there. Callers that do not care about attributes run the result
 * through `stripAnsi`, so one capture serves every detector.
 */
export async function capturePaneStyled(
  m: MachineConfig,
  name: string,
  lines: number,
): Promise<string> {
  const { stdout } = await run(
    tmuxArgv(m, 'capture-pane', '-t', paneTarget(name), '-p', '-e', '-S', `-${lines}`),
  );
  return stdout;
}

/** Is a human interactively attached to this session? Chat delivery holds while true so an
 *  injected message never interleaves with someone typing in the pane (racy to detect otherwise). */
export async function hasAttachedClient(m: MachineConfig, name: string): Promise<boolean> {
  const { code, stdout } = await run(
    tmuxArgv(m, 'list-clients', '-t', exactTarget(name), '-F', '#{client_name}'),
  );
  return code === 0 && stdout.trim() !== '';
}

/** Did an attached human touch the keyboard within the last `withinSec`? Watching a pane is harmless
 *  for chat delivery — typing into it is not (our injected line would land in their half-written
 *  one). `client_activity` is tmux's own last-input timestamp, so this asks the precise question
 *  instead of the blunt "is anyone attached". No client attached → false. */
export async function clientTypingRecently(
  m: MachineConfig,
  name: string,
  withinSec: number,
): Promise<boolean> {
  const { code, stdout } = await run(
    tmuxArgv(m, 'list-clients', '-t', exactTarget(name), '-F', '#{client_activity}'),
  );
  if (code !== 0) return false;
  const nowSec = Date.now() / 1000;
  for (const line of stdout.trim().split('\n')) {
    const at = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(at) && nowSec - at <= withinSec) return true;
  }
  return false;
}
