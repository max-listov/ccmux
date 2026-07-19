import type { MachineConfig } from "../types.ts";
import { run, runWithInput } from "../util/spawn.ts";
import { exactTarget, paneTarget } from "./target.ts";

// Typed tmux wrappers — every call is an argv array via util/spawn. All targeting
// goes through target.ts; no bare `-t name` anywhere.

/** Base tmux argv, scoped to the config's optional dedicated socket (`-L`). EVERY tmux invocation
 *  goes through this, so an isolated instance (dev) is fully confined to its own tmux server. Unset
 *  socket → the default socket (prod), i.e. current behaviour. Exported for the test. */
export function tmuxArgv(m: MachineConfig, ...args: string[]): string[] {
  return m.tmuxSocket ? [m.tmuxBin, "-L", m.tmuxSocket, ...args] : [m.tmuxBin, ...args];
}

export async function hasSession(m: MachineConfig, name: string): Promise<boolean> {
  const { code } = await run(tmuxArgv(m, "has-session", "-t", exactTarget(name)));
  return code === 0;
}

/** One fork per tick instead of N has-session calls (P3-15). */
export async function listSessionNames(m: MachineConfig): Promise<Set<string>> {
  const { code, stdout } = await run(tmuxArgv(m, "list-sessions", "-F", "#{session_name}"));
  if (code !== 0) return new Set();
  return new Set(stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""));
}

/** name → session_created (epoch seconds) for every live session — one fork, for `list`
 *  uptime. Parses the trailing epoch so session names containing spaces still work. */
export async function listSessionsCreated(m: MachineConfig): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { code, stdout } = await run(tmuxArgv(m, "list-sessions", "-F", "#{session_name} #{session_created}"));
  if (code !== 0) return out;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const sp = trimmed.lastIndexOf(" ");
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
const INSTANCE_ENV_KEYS = ["CCMUX_HOME", "CCMUX_CONFIG", "CCMUX_SESSIONS"] as const;

function instanceEnvArgs(): string[] {
  const out: string[] = [];
  for (const key of INSTANCE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined && v !== "") out.push("-e", `${key}=${v}`);
  }
  return out;
}

export async function newSession(
  m: MachineConfig,
  name: string,
  dir: string,
  cmd: string[],
): Promise<void> {
  // `-s NAME` (plain, for creation), `-e` pins the instance env into the pane (see above), `--` so
  // tmux treats the rest as command tokens.
  await run(tmuxArgv(m, "new-session", "-d", "-s", name, "-c", dir, ...instanceEnvArgs(), "--", ...cmd));
}

export async function killSession(m: MachineConfig, name: string): Promise<boolean> {
  const { code } = await run(tmuxArgv(m, "kill-session", "-t", exactTarget(name)));
  return code === 0;
}

export async function setOption(
  m: MachineConfig,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run(tmuxArgv(m, "set-option", "-t", exactTarget(name), key, value)); // best-effort
}

/** Pane-scoped option on the session's single pane (e.g. allow-passthrough) — kept
 *  session-local so ccmux never mutates the shared tmux server's global options. */
export async function setPaneOption(
  m: MachineConfig,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run(tmuxArgv(m, "set-option", "-p", "-t", paneTarget(name), key, value)); // best-effort
}

/** Literal text (`-l`) — for sending user/prompt text. */
export async function sendKeysLiteral(m: MachineConfig, name: string, text: string): Promise<boolean> {
  // `--` so a payload starting with "-" is treated as literal text, not a tmux flag
  const { code } = await run(tmuxArgv(m, "send-keys", "-t", paneTarget(name), "-l", "--", text));
  return code === 0;
}

/** Named keys (NO `-l`) — Enter/Up/Escape/C-c (P3-13: distinct from literal). */
export async function sendKeysNamed(m: MachineConfig, name: string, key: string): Promise<void> {
  await run(tmuxArgv(m, "send-keys", "-t", paneTarget(name), key));
}

/** Insert `text` into the pane as a BRACKETED paste (so a multi-line block goes in as one unit
 *  that does NOT submit — the caller sends Enter). Payload rides stdin via `load-buffer -` (no
 *  argv length limit / escaping); `-d` drops the buffer after. Returns false if either step fails. */
export async function pasteText(m: MachineConfig, name: string, text: string): Promise<boolean> {
  const loaded = await runWithInput(tmuxArgv(m, "load-buffer", "-b", "ccmux-chat", "-"), text);
  if (loaded.code !== 0) return false;
  const { code } = await run(tmuxArgv(m, "paste-buffer", "-p", "-d", "-b", "ccmux-chat", "-t", paneTarget(name)));
  return code === 0;
}

export async function capturePane(m: MachineConfig, name: string, lines: number): Promise<string> {
  const { stdout } = await run(tmuxArgv(m, "capture-pane", "-t", paneTarget(name), "-p", "-S", `-${lines}`));
  return stdout;
}

/** Is a human interactively attached to this session? Chat delivery holds while true so an
 *  injected message never interleaves with someone typing in the pane (racy to detect otherwise). */
export async function hasAttachedClient(m: MachineConfig, name: string): Promise<boolean> {
  const { code, stdout } = await run(tmuxArgv(m, "list-clients", "-t", exactTarget(name), "-F", "#{client_name}"));
  return code === 0 && stdout.trim() !== "";
}
