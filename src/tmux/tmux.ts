import type { MachineConfig } from "../types.ts";
import { run } from "../util/spawn.ts";
import { exactTarget, paneTarget } from "./target.ts";

// Typed tmux wrappers — every call is an argv array via util/spawn. All targeting
// goes through target.ts; no bare `-t name` anywhere.

export async function hasSession(m: MachineConfig, name: string): Promise<boolean> {
  const { code } = await run([m.tmuxBin, "has-session", "-t", exactTarget(name)]);
  return code === 0;
}

/** One fork per tick instead of N has-session calls (P3-15). */
export async function listSessionNames(m: MachineConfig): Promise<Set<string>> {
  const { code, stdout } = await run([m.tmuxBin, "list-sessions", "-F", "#{session_name}"]);
  if (code !== 0) return new Set();
  return new Set(stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""));
}

/** name → session_created (epoch seconds) for every live session — one fork, for `list`
 *  uptime. Parses the trailing epoch so session names containing spaces still work. */
export async function listSessionsCreated(m: MachineConfig): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const { code, stdout } = await run([m.tmuxBin, "list-sessions", "-F", "#{session_name} #{session_created}"]);
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

export async function newSession(
  m: MachineConfig,
  name: string,
  dir: string,
  cmd: string[],
): Promise<void> {
  // `-s NAME` (plain, for creation) + `--` so tmux treats the rest as command tokens.
  await run([m.tmuxBin, "new-session", "-d", "-s", name, "-c", dir, "--", ...cmd]);
}

export async function killSession(m: MachineConfig, name: string): Promise<boolean> {
  const { code } = await run([m.tmuxBin, "kill-session", "-t", exactTarget(name)]);
  return code === 0;
}

export async function setOption(
  m: MachineConfig,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run([m.tmuxBin, "set-option", "-t", exactTarget(name), key, value]); // best-effort
}

/** Pane-scoped option on the session's single pane (e.g. allow-passthrough) — kept
 *  session-local so ccmux never mutates the shared tmux server's global options. */
export async function setPaneOption(
  m: MachineConfig,
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run([m.tmuxBin, "set-option", "-p", "-t", paneTarget(name), key, value]); // best-effort
}

/** Literal text (`-l`) — for sending user/prompt text. */
export async function sendKeysLiteral(m: MachineConfig, name: string, text: string): Promise<boolean> {
  // `--` so a payload starting with "-" is treated as literal text, not a tmux flag
  const { code } = await run([m.tmuxBin, "send-keys", "-t", paneTarget(name), "-l", "--", text]);
  return code === 0;
}

/** Named keys (NO `-l`) — Enter/Up/Escape/C-c (P3-13: distinct from literal). */
export async function sendKeysNamed(m: MachineConfig, name: string, key: string): Promise<void> {
  await run([m.tmuxBin, "send-keys", "-t", paneTarget(name), key]);
}

export async function capturePane(m: MachineConfig, name: string, lines: number): Promise<string> {
  const { stdout } = await run([m.tmuxBin, "capture-pane", "-t", paneTarget(name), "-p", "-S", `-${lines}`]);
  return stdout;
}
