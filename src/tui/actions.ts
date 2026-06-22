import type { MachineConfig, Session } from "../types.ts";
import { killSession, sendKeysLiteral, sendKeysNamed, capturePane } from "../tmux/tmux.ts";
import { removeSession, appendSession } from "../config/sessions.ts";
import { startSession } from "../commands/lifecycle.ts";
import { providerFor } from "../agent/index.ts";
import { adoptSession, forkAdopt, takeoverAdopt, LiveWritersError } from "../commands/adopt.ts";
import type { Writer } from "../agent/claude/writers.ts";
import { runDetached } from "../util/spawn.ts";
import { SELF_ARGV } from "../env.ts";
import { SessionSchema } from "../config/schema.ts";

/** Poll the pane until the agent's UI is actually drawn (model banner visible) or timeout —
 *  so we attach to a READY session, not a half-booted blank pane. Mirrors bash `wait_ready`. */
export async function waitReady(m: MachineConfig, session: Session, timeoutMs = 6000): Promise<void> {
  const provider = providerFor(session);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const scan = provider.scanPane(await capturePane(m, session.name, 30));
      if (scan.model !== null || scan.state === "working") return; // UI drawn / agent active
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

export async function restartSession(m: MachineConfig, name: string): Promise<void> {
  await killSession(m, name);
  // detached worker outlives the kill, waits, relaunches (same path as `ccmux restart`)
  runDetached([...SELF_ARGV, "_restart-worker", name, ""]);
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
  if (body === "") return false;
  const ok = await sendKeysLiteral(m, name, body);
  if (!ok) return false;
  await Bun.sleep(150); // let the agent's readline drain the literal text before Enter (race)
  await sendKeysNamed(m, name, "Enter");
  return true;
}

/** Outcome of an adopt attempt from the TUI: adopted cleanly, or blocked by live writers
 *  (the caller then offers fork/takeover), or failed. */
export type AdoptResult = { ok: true; name: string } | { ok: false; writers: Writer[] } | { ok: false; writers: null };

/** Try a COLD adopt of an external (discovered) session. Live writers → no side effects,
 *  returns them so the UI can ask fork-or-takeover. Silent (TUI refreshes via poll). */
export async function adoptExternal(m: MachineConfig, dir: string, uuid: string): Promise<AdoptResult> {
  try {
    return { ok: true, name: await adoptSession(m, dir, uuid) };
  } catch (e) {
    if (e instanceof LiveWritersError) return { ok: false, writers: e.writers };
    return { ok: false, writers: null };
  }
}

/** Fork-adopt (copy under a new uuid — always safe). "" on error. */
export async function forkAdoptExternal(m: MachineConfig, uuid: string): Promise<string> {
  try {
    return await forkAdopt(m, uuid);
  } catch {
    return "";
  }
}

/** Takeover-adopt (kill writers, adopt original). "" on error (incl. self-writer refusal). */
export async function takeoverExternal(m: MachineConfig, dir: string, uuid: string): Promise<string> {
  try {
    return await takeoverAdopt(m, dir, uuid);
  } catch {
    return "";
  }
}


/** Register a new session (pins a fresh uuid) and start it. Returns its name for attach. */
export async function createSession(m: MachineConfig, name: string, dir: string): Promise<Session> {
  const s = SessionSchema.parse({ name, dir, uuid: crypto.randomUUID() });
  await appendSession(m, s);
  await startSession(m, name, dir);
  return s;
}
