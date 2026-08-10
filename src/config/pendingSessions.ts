import { PendingSessionSchema, SessionSchema } from "./schema.ts";
import type { MachineConfig, PendingSession, Session } from "../types.ts";
import { withSessionRegistryLock } from "./registryLock.ts";
import { findSession, loadSessions, writeSessionsUnlocked } from "./sessions.ts";
import { loadPendingRows, writePendingRows } from "./pendingStore.ts";
import { promotedPending, recoverPromotionsUnlocked } from "./sessionRegistry.ts";

export function loadPendingSessions(m: MachineConfig): PendingSession[] {
  return loadPendingRows(m).filter((item) => item.status !== "promoted");
}

export async function reservePendingSession(m: MachineConfig, pending: PendingSession): Promise<void> {
  await withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const sessions = loadSessions(m);
    const current = loadPendingRows(m);
    if (findSession(sessions, pending.session.name) || current.some((item) => item.session.name === pending.session.name)) {
      throw new Error(`'${pending.session.name}' already exists`);
    }
    await writePendingRows(m, [...current, PendingSessionSchema.parse(pending)]);
  });
}

export async function markPendingBlocked(m: MachineConfig, generation: string, error: string): Promise<void> {
  await withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadPendingRows(m);
    const target = current.find((item) => item.generation === generation);
    if (!target) return;
    await writePendingRows(m, current.map((item) => item.generation === generation ? { ...item, status: "blocked", error } : item));
  });
}

export async function removePendingSession(m: MachineConfig, generation: string): Promise<void> {
  await withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadPendingRows(m);
    await writePendingRows(m, current.filter((item) => item.generation !== generation));
  });
}

/** CAS promotion: exact generation+name must still be pending and the real UUID must be unclaimed. */
export async function promotePendingSession(m: MachineConfig, generation: string, uuid: string): Promise<Session> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const pending = loadPendingRows(m);
    const target = pending.find((item) => item.generation === generation && item.status === "pending");
    if (!target) throw new Error("pending launch was removed, replaced, or blocked before promotion");
    const sessions = loadSessions(m);
    if (findSession(sessions, target.session.name)) throw new Error("session name was claimed before promotion");
    if (sessions.some((item) => item.uuid === uuid)) throw new Error("provider thread id is already claimed");
    const ready = SessionSchema.parse({ ...target.session, uuid, registrationGeneration: generation });
    // Journal first: every read treats `promoted` as ready, and the next locked mutation completes
    // either interrupted write boundary idempotently.
    await writePendingRows(m, pending.map((item) => item.generation === generation ? promotedPending(item, uuid) : item));
    await writeSessionsUnlocked(m, [...sessions, ready]);
    await writePendingRows(m, pending.filter((item) => item.generation !== generation));
    return ready;
  });
}
