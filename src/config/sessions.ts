import { existsSync, readFileSync } from "node:fs";
import { SessionSchema } from "./schema.ts";
import type { Session, MachineConfig, PermissionMode } from "../types.ts";
import { atomicWrite } from "../util/atomic.ts";

const HEADER = "# managed Claude sessions — ccmux owns this file (JSONL)";

/**
 * Load all managed sessions. Always reads fresh from disk — NEVER caches (the
 * daemon re-read fix). New writes are JSONL; legacy `name|dir|uuid` lines are
 * tolerated on read and rewritten as JSONL on the first mutation.
 */
export function loadSessions(m: MachineConfig): Session[] {
  if (!existsSync(m.sessionsFile)) return [];
  const out: Session[] = [];
  for (const raw of readFileSync(m.sessionsFile, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    out.push(parseLine(line));
  }
  return out;
}

function parseLine(line: string): Session {
  if (line.startsWith("{")) {
    const obj: unknown = JSON.parse(line);
    return SessionSchema.parse(obj);
  }
  // legacy fixed-delimiter format: exactly name|dir|uuid
  const parts = line.split("|");
  if (parts.length !== 3) throw new Error(`bad sessions line (expected name|dir|uuid): ${line}`);
  return SessionSchema.parse({ name: parts[0], dir: parts[1], uuid: parts[2] });
}

export function findSession(sessions: Session[], name: string): Session | undefined {
  return sessions.find((s) => s.name === name);
}

export async function appendSession(m: MachineConfig, s: Session): Promise<void> {
  const current = loadSessions(m);
  if (findSession(current, s.name)) throw new Error(`'${s.name}' already in ${m.sessionsFile}`);
  await writeSessions(m, [...current, s]);
}

/** Re-pin a session to a new conversation uuid (follow-the-fork). Returns false if the
 *  name wasn't present. History files are never touched — both jsonls stay on disk. */
export async function updateSessionUuid(m: MachineConfig, name: string, uuid: string): Promise<boolean> {
  const current = loadSessions(m);
  const target = findSession(current, name);
  if (!target) return false;
  await writeSessions(m, current.map((s) => (s.name === name ? { ...s, uuid } : s)));
  return true;
}

/** Set (or clear) a session's per-session permission-mode override. `mode === undefined`
 *  clears it → the session falls back to the machine default. Returns false if the name
 *  wasn't present. Takes effect on the next (re)start — the mode is a launch-time flag. */
export async function setSessionPermissionMode(
  m: MachineConfig,
  name: string,
  mode: PermissionMode | undefined,
): Promise<boolean> {
  const current = loadSessions(m);
  if (!findSession(current, name)) return false;
  // mode:undefined omits the key on JSON.stringify → the override is truly cleared.
  await writeSessions(
    m,
    current.map((s) => (s.name === name ? { ...s, permissionMode: mode } : s)),
  );
  return true;
}

/** Toggle a session's inter-agent chat opt-in. Returns false if the name wasn't present.
 *  Effective immediately (the store re-reads sessions on every send/deliver) — not a launch flag. */
export async function setSessionChatEnabled(m: MachineConfig, name: string, enabled: boolean): Promise<boolean> {
  const current = loadSessions(m);
  if (!findSession(current, name)) return false;
  await writeSessions(m, current.map((s) => (s.name === name ? { ...s, chatEnabled: enabled } : s)));
  return true;
}

/** Enable/disable ROUTER mode on a session: add/remove the "router" prompt module, and — since a
 *  router drives ccmux chat (`msg`/`inbox`) — also enable chat when turning it on (leaving chat as-is
 *  when turning off). Launch-time, like the other prompt-affecting fields: applies on next restart.
 *  Returns false if the name wasn't present. */
export async function setSessionRouter(m: MachineConfig, name: string, on: boolean): Promise<boolean> {
  const current = loadSessions(m);
  if (!findSession(current, name)) return false;
  await writeSessions(
    m,
    current.map((s) => {
      if (s.name !== name) return s;
      const mods = new Set(s.promptModules);
      if (on) mods.add("router");
      else mods.delete("router");
      return { ...s, promptModules: [...mods], chatEnabled: on ? true : s.chatEnabled };
    }),
  );
  return true;
}

/** Returns false if the name wasn't present. Never touches the jsonl history. */
export async function removeSession(m: MachineConfig, name: string): Promise<boolean> {
  const current = loadSessions(m);
  if (!findSession(current, name)) return false;
  await writeSessions(m, current.filter((s) => s.name !== name));
  return true;
}

async function writeSessions(m: MachineConfig, sessions: Session[]): Promise<void> {
  const body = sessions.map((s) => JSON.stringify(s)).join("\n");
  await atomicWrite(m.sessionsFile, `${HEADER}\n${body}${body ? "\n" : ""}`);
}
