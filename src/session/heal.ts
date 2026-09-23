import { forkedUuid } from '../agent/index.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { listAgentLiveness } from '../tmux/agentPane.ts';
import { killSession } from '../tmux/tmux.ts';
import type { Session } from '../types.ts';
import { log } from '../util/log.ts';
import { readLifecycleBlockForSession } from './lifecycleBlocks.ts';
import { findSession, loadSessions, updateSessionUuid } from './registry.ts';
import { startSession } from './start.ts';

type EnsureDeps = {
  sessions: () => Session[];
  /** Sessions whose agent runs, and sessions that exist while their agent's pane is gone. */
  observe: () => Promise<{ live: Set<string>; agentGone: Set<string> }>;
  /** Take down a session whose agent is gone, so it can be started again. */
  retire: (name: string) => Promise<void>;
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
  const { live, agentGone } = await deps.observe();
  for (const s of deps.sessions()) {
    if (s.archived) continue;
    const cur = await deps.followFork(s);
    if (live.has(cur.name)) continue;
    // A session kept alive by another window after its agent died is down, not up: it is taken down
    // whole — its other windows live and die with it — and started like any other down session.
    if (agentGone.has(cur.name)) await deps.retire(cur.name);
    await deps.start(cur.name, cur.dir);
  }
}

/** One heal pass over this machine's sessions: start what is down, follow forks, and take down a
 *  session kept alive by another window after its agent died. The daemon runs it every second. */
export async function healOnce(): Promise<void> {
  const m = loadMachineConfig(); // fresh
  await ensureOnce({
    sessions: () => loadSessions(m), // fresh — no module-level cache
    observe: () => listAgentLiveness(m), // one fork per tick (P3-15)
    retire: async (name) => {
      log.warn({ msg: 'heal: agent pane gone while the session lived on — taking it down', name });
      await killSession(m, name);
    },
    followFork: async (s) => {
      const next = forkedUuid(s, m, loadSessions(m));
      if (next === null) return s;
      log.info({
        msg: 'follow fork: conversation moved — re-pinning',
        name: s.name,
        from: s.uuid,
        to: next,
      });
      await updateSessionUuid(m, s.name, next);
      return { ...s, uuid: next };
    },
    start: (name, dir) => {
      const session = findSession(loadSessions(m), name);
      if (!session || readLifecycleBlockForSession(m, session)) return Promise.resolve();
      log.info({ msg: 'heal: session down — restarting', name });
      return startSession(m, name, dir);
    },
  });
}
