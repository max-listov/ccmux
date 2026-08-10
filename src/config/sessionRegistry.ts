import type { MachineConfig, PendingSession, Session } from "../types.ts";
import { PendingSessionSchema, SessionSchema } from "./schema.ts";
import { loadPendingRows, writePendingRows } from "./pendingStore.ts";
import { loadReadyRows, writeReadyRows } from "./sessionStore.ts";

function promotedSession(pending: PendingSession): Session | null {
  if (pending.status !== "promoted" || pending.uuid === undefined) return null;
  return SessionSchema.parse({
    ...pending.session,
    uuid: pending.uuid,
    registrationGeneration: pending.generation,
  });
}

/** Read view is crash-safe: a promoted journal row is already authoritative ready identity. */
export function loadRegistrySessions(m: MachineConfig): Session[] {
  // Promotion writes journal → ready → journal cleanup. Read in the same order so a concurrent
  // reader sees either the promoted journal before cleanup or the ready row after cleanup.
  const pending = loadPendingRows(m);
  const ready = loadReadyRows(m);
  for (const pendingRow of pending) {
    const promoted = promotedSession(pendingRow);
    if (!promoted) continue;
    const byName = ready.find((session) => session.name === promoted.name);
    if (byName) {
      if (byName.uuid !== promoted.uuid || byName.registrationGeneration !== promoted.registrationGeneration) {
        throw new Error(`promoted session '${promoted.name}' conflicts with the ready registry`);
      }
      continue;
    }
    if (ready.some((session) => session.uuid === promoted.uuid)) {
      throw new Error(`promoted uuid '${promoted.uuid}' conflicts with the ready registry`);
    }
    ready.push(promoted);
  }
  return ready;
}

/** Complete or clean any promoted journal rows. Caller owns the session-registry lock. */
export async function recoverPromotionsUnlocked(m: MachineConfig): Promise<void> {
  const pending = loadPendingRows(m);
  const promoted = pending.map(promotedSession).filter((session): session is Session => session !== null);
  if (promoted.length === 0) return;
  const ready = loadReadyRows(m);
  let changed = false;
  for (const session of promoted) {
    const byName = ready.find((item) => item.name === session.name);
    if (byName) {
      if (byName.uuid !== session.uuid || byName.registrationGeneration !== session.registrationGeneration) {
        throw new Error(`promoted session '${session.name}' conflicts with the ready registry`);
      }
      continue;
    }
    if (ready.some((item) => item.uuid === session.uuid)) {
      throw new Error(`promoted uuid '${session.uuid}' conflicts with the ready registry`);
    }
    ready.push(session);
    changed = true;
  }
  if (changed) await writeReadyRows(m, ready);
  await writePendingRows(m, pending.filter((item) => item.status !== "promoted"));
}

export function promotedPending(pending: PendingSession, uuid: string): PendingSession {
  return PendingSessionSchema.parse({ ...pending, status: "promoted", uuid });
}
