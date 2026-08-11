import type { Session, MachineConfig, PermissionMode } from "../types.ts";
import { sessionsPath } from "./paths.ts";
import { withSessionRegistryLock } from "./registryLock.ts";
import { loadPendingRows } from "./pendingStore.ts";
import { loadRegistrySessions, recoverPromotionsUnlocked } from "./sessionRegistry.ts";
import { writeReadyRows } from "./sessionStore.ts";

/**
 * Load all managed sessions. Always reads fresh from disk — NEVER caches (the
 * daemon re-read fix). Every v2 row is JSON with an explicit agent; the old pipe format is not
 * accepted because it cannot state the provider and therefore cannot be routed safely.
 */
export function loadSessions(m: MachineConfig): Session[] {
  return loadRegistrySessions(m);
}

export function findSession(sessions: Session[], name: string): Session | undefined {
  return sessions.find((s) => s.name === name);
}

export async function appendSession(m: MachineConfig, s: Session): Promise<void> {
  await withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    if (findSession(current, s.name)) throw new Error(`'${s.name}' already in ${sessionsPath(m)}`);
    if (loadPendingRows(m).some((pending) => pending.session.name === s.name)) {
      throw new Error(`'${s.name}' already has a pending create transaction`);
    }
    if (current.some((item) => item.uuid === s.uuid)) throw new Error(`uuid '${s.uuid}' already managed`);
    await writeSessionsUnlocked(m, [...current, s]);
  });
}

/** Re-pin a session to a new conversation uuid (follow-the-fork). Returns false if the
 *  name wasn't present. History files are never touched — both jsonls stay on disk. */
export async function updateSessionUuid(m: MachineConfig, name: string, uuid: string): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    const target = findSession(current, name);
    if (!target) return false;
    if (current.some((item) => item.name !== name && item.uuid === uuid)) throw new Error(`uuid '${uuid}' already managed`);
    await writeSessionsUnlocked(m, current.map((s) => (s.name === name ? { ...s, uuid } : s)));
    return true;
  });
}

/** Set (or clear) a session's per-session permission-mode override. `mode === undefined`
 *  clears it → the session falls back to the machine default. Returns false if the name
 *  wasn't present. Takes effect on the next (re)start — the mode is a launch-time flag. */
export async function setSessionPermissionMode(
  m: MachineConfig,
  name: string,
  mode: PermissionMode | undefined,
): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    if (!findSession(current, name)) return false;
    await writeSessionsUnlocked(m, current.map((s) => (s.name === name ? { ...s, permissionMode: mode } : s)));
    return true;
  });
}

/** Toggle a session's inter-agent chat opt-in. Returns false if the name wasn't present.
 *  Effective immediately (the store re-reads sessions on every send/deliver) — not a launch flag. */
/** `enabled === undefined` CLEARS the override so the session inherits the machine default —
 *  the same shape as clearing a permission-mode override. */
export async function setSessionChatEnabled(m: MachineConfig, name: string, enabled: boolean | undefined): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    if (!findSession(current, name)) return false;
    await writeSessionsUnlocked(m, current.map((s) => {
      if (s.name !== name) return s;
      const { chatEnabled: _drop, ...rest } = s;
      return enabled === undefined ? rest : { ...rest, chatEnabled: enabled };
    }));
    return true;
  });
}

/** Enable/disable ROUTER mode on a session: add/remove the "router" prompt module, and — since a
 *  router drives ccmux chat (`msg`/`inbox`) — also enable chat when turning it on (leaving chat as-is
 *  when turning off). Launch-time, like the other prompt-affecting fields: applies on next restart.
 *  Returns false if the name wasn't present. */
export async function setSessionRouter(m: MachineConfig, name: string, on: boolean): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    if (!findSession(current, name)) return false;
    await writeSessionsUnlocked(m, current.map((s) => {
      if (s.name !== name) return s;
      const mods = new Set(s.promptModules);
      if (on) mods.add("router");
      else mods.delete("router");
      return { ...s, promptModules: [...mods], chatEnabled: on ? true : s.chatEnabled };
    }));
    return true;
  });
}

/** Returns false if the name wasn't present. Never touches the jsonl history. */
export async function removeSession(m: MachineConfig, name: string): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    if (!findSession(current, name)) return false;
    await writeSessionsUnlocked(m, current.filter((s) => s.name !== name));
    return true;
  });
}

export async function removeSessionIfUuid(m: MachineConfig, name: string, uuid: string): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    const target = findSession(current, name);
    if (!target || target.uuid !== uuid) return false;
    await writeSessionsUnlocked(m, current.filter((s) => s.name !== name));
    return true;
  });
}

export async function removeSessionIfGeneration(m: MachineConfig, name: string, generation: string): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const current = loadSessions(m);
    const target = findSession(current, name);
    if (!target || target.registrationGeneration !== generation) return false;
    await writeSessionsUnlocked(m, current.filter((s) => s.name !== name));
    return true;
  });
}

export async function writeSessionsUnlocked(m: MachineConfig, sessions: Session[]): Promise<void> {
  await writeReadyRows(m, sessions);
}
