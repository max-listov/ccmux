import type { Writer } from '../agent/claude/writers.ts';
import { providerFor } from '../agent/index.ts';
import {
  adoptCodexExternal,
  adoptSession,
  forkAdopt,
  forkCodexExternal,
  LiveWritersError,
  takeoverAdopt,
  takeoverCodexExternal,
} from '../commands/adopt.ts';
import { createManagedSession } from '../commands/create.ts';
import { removeSession } from '../config/sessions.ts';
import { SELF_ARGV } from '../env.ts';
import { capturePane, killSession, sendKeysLiteral, sendKeysNamed } from '../tmux/tmux.ts';
import type { AgentKind, MachineConfig, Session } from '../types.ts';
import { runDetached } from '../util/spawn.ts';
import type { DiscoveredSession } from './discover.ts';

/** Poll the pane until the agent's interactive UI is actually drawn (ready marker) or timeout —
 *  so we attach to a READY session, not a half-booted blank pane. Mirrors bash `wait_ready`. */
export async function waitReady(
  m: MachineConfig,
  session: Session,
  timeoutMs = 6000,
): Promise<void> {
  const provider = providerFor(session);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const scan = provider.scanPane(await capturePane(m, session.name, 30));
      if (scan.ready) return; // UI drawn (ready covers both idle-booted and working)
    } catch {
      // session not up yet — keep polling
    }
    await Bun.sleep(200);
  }
}

// Silent fleet actions for the TUI — the same low-level ops the CLI commands wrap, but
// WITHOUT console output (which would corrupt the Ink render). The TUI refreshes via the
// poll after calling these.

export async function stopSession(m: MachineConfig, name: string): Promise<void> {
  await killSession(m, name);
}

/** Restart EVERY session on this machine (TUI `R`). Hands the sweep to the same detached driver the
 *  CLI uses, so it survives this TUI exiting and never blocks the render loop; the fleet poll shows
 *  the wave of stopped → idle transitions as it walks the list. */
export function restartAllSessions(): void {
  runDetached([...SELF_ARGV, '_restart-all-worker']);
}

export async function restartSession(m: MachineConfig, name: string): Promise<void> {
  await killSession(m, name);
  // detached worker outlives the kill, waits, relaunches (same path as `ccmux restart`)
  runDetached([...SELF_ARGV, '_restart-worker', name]);
}

export async function removeSessionFully(m: MachineConfig, name: string): Promise<void> {
  await killSession(m, name);
  await removeSession(m, name); // jsonl history kept on disk
}

/** Send a chat message into a running session's pane — type the literal text, let readline
 *  drain it, then a separate Enter to submit (the same flow as `ccmux send`). Agent-neutral:
 *  Claude/Codex receive it as if typed (slash-commands work, queued if the agent is busy).
 *  Returns false when the pane isn't live (e.g. a stopped or external session). */
export async function sendMessage(m: MachineConfig, name: string, text: string): Promise<boolean> {
  const body = text.trim();
  if (body === '') return false;
  const ok = await sendKeysLiteral(m, name, body);
  if (!ok) return false;
  await Bun.sleep(150); // let the agent's readline drain the literal text before Enter (race)
  await sendKeysNamed(m, name, 'Enter');
  return true;
}

/** Outcome of an adopt attempt from the TUI: adopted cleanly, or blocked by live writers
 *  (the caller then offers fork/takeover), or failed. */
export type OwnershipResult =
  | { ok: true; name: string }
  | { ok: false; writers: Writer[] | null; error: string };

/** Try a COLD adopt of an external (discovered) session. Live writers → no side effects,
 *  returns them so the UI can ask fork-or-takeover. Silent (TUI refreshes via poll). */
export async function adoptExternal(
  m: MachineConfig,
  ext: DiscoveredSession,
): Promise<OwnershipResult> {
  try {
    if (!ext.dir)
      return { ok: false, writers: null, error: 'external session has no persisted cwd' };
    const name =
      ext.provider === 'codex'
        ? await adoptCodexExternal(m, ext.threadId)
        : await adoptSession(m, ext.dir, ext.threadId);
    return { ok: true, name };
  } catch (e) {
    if (e instanceof LiveWritersError) return { ok: false, writers: e.writers, error: e.message };
    return { ok: false, writers: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Provider-native fork into a new managed identity. */
export async function forkAdoptExternal(
  m: MachineConfig,
  ext: DiscoveredSession,
): Promise<OwnershipResult> {
  try {
    const name =
      ext.provider === 'codex'
        ? await forkCodexExternal(m, ext.threadId)
        : await forkAdopt(m, ext.threadId);
    return { ok: true, name };
  } catch (error) {
    return {
      ok: false,
      writers: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Takeover-adopt a freshly revalidated dedicated writer. */
export async function takeoverExternal(
  m: MachineConfig,
  ext: DiscoveredSession,
): Promise<OwnershipResult> {
  try {
    if (!ext.dir)
      return { ok: false, writers: null, error: 'external session has no persisted cwd' };
    if (ext.provider === 'codex') {
      const pid = ext.writerRuntime?.pid;
      if (pid === null || pid === undefined) {
        return { ok: false, writers: null, error: 'Codex writer PID is not positively identified' };
      }
      return { ok: true, name: await takeoverCodexExternal(m, ext.threadId, pid) };
    }
    return { ok: true, name: await takeoverAdopt(m, ext.dir, ext.threadId) };
  } catch (error) {
    return {
      ok: false,
      writers: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Register a new session (pins a fresh uuid) and start it. Returns its name for attach. */
export async function createSession(
  m: MachineConfig,
  name: string,
  dir: string,
  agent: AgentKind,
): Promise<Session> {
  return createManagedSession(m, { name, dir, agent, flags: [], router: false });
}
