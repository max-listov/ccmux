import type { Session } from "../types.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions } from "../config/sessions.ts";
import { listSessionNames } from "../tmux/tmux.ts";
import { log } from "../util/log.ts";
import { startSession } from "./lifecycle.ts";

type EnsureDeps = {
  sessions: () => Session[];
  listRunning: () => Promise<Set<string>>;
  start: (name: string, dir: string) => Promise<void>;
};

/** Pure heal logic over injected deps — re-reads sessions each call, starts only
 *  down + non-archived sessions. Dependency-injected so it's unit-testable without tmux. */
export async function ensureOnce(deps: EnsureDeps): Promise<void> {
  const running = await deps.listRunning();
  for (const s of deps.sessions()) {
    if (s.archived) continue;
    if (running.has(s.name)) continue;
    await deps.start(s.name, s.dir);
  }
}

export async function cmdEnsure(): Promise<number> {
  const m = loadMachineConfig(); // fresh
  await ensureOnce({
    sessions: () => loadSessions(m), // fresh — no module-level cache
    listRunning: () => listSessionNames(m), // one fork per tick (P3-15)
    start: (name, dir) => {
      log.info({ msg: "heal: session down — restarting", name });
      return startSession(m, name, dir);
    },
  });
  return 0;
}
