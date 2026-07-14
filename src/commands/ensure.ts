import type { Session } from "../types.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, updateSessionUuid } from "../config/sessions.ts";
import { forkedUuid } from "../agent/index.ts";
import { listSessionNames } from "../tmux/tmux.ts";
import { log } from "../util/log.ts";
import { startSession } from "./lifecycle.ts";

type EnsureDeps = {
  sessions: () => Session[];
  listRunning: () => Promise<Set<string>>;
  // Follow-the-fork: if the agent moved the conversation to a new uuid, re-pin the
  // registry and return the updated session; unchanged otherwise. Runs BEFORE the
  // start decision so a heal/reboot resumes the conversation where it lives NOW.
  followFork: (s: Session) => Promise<Session>;
  start: (name: string, dir: string) => Promise<void>;
};

/** Pure heal logic over injected deps — re-reads sessions each call, follows forks,
 *  starts only down + non-archived sessions. Dependency-injected so it's unit-testable
 *  without tmux or a real registry. */
export async function ensureOnce(deps: EnsureDeps): Promise<void> {
  const running = await deps.listRunning();
  for (const s of deps.sessions()) {
    if (s.archived) continue;
    const cur = await deps.followFork(s);
    if (running.has(cur.name)) continue;
    await deps.start(cur.name, cur.dir);
  }
}

export async function cmdEnsure(): Promise<number> {
  const m = loadMachineConfig(); // fresh
  await ensureOnce({
    sessions: () => loadSessions(m), // fresh — no module-level cache
    listRunning: () => listSessionNames(m), // one fork per tick (P3-15)
    followFork: async (s) => {
      const next = forkedUuid(s, m, loadSessions(m));
      if (next === null) return s;
      log.info({ msg: "follow fork: conversation moved — re-pinning", name: s.name, from: s.uuid, to: next });
      await updateSessionUuid(m, s.name, next);
      return { ...s, uuid: next };
    },
    start: (name, dir) => {
      log.info({ msg: "heal: session down — restarting", name });
      return startSession(m, name, dir);
    },
  });
  return 0;
}
