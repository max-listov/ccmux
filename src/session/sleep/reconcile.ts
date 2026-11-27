import { withNativeAdmission } from '../../runtime/admission.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { forgetAgentPane } from '../../tmux/agentPane.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { clearStatus } from '../status.ts';
import { processesReleasedAsync, sessionHasFreshLiveProcess, tmuxSessionAlive } from './release.ts';
import type { SleepRecord } from './schema.ts';
import { readSleepSafe, writeSleep } from './store.ts';

const STALE_PHASE_MS = 30_000;

/**
 * Reconcile crash-interrupted intermediate sleep phases (`requested` or `waking`) so a daemon or
 * host reboot can never wedge a session permanently in `SLEEP_PENDING`.
 *
 * - `requested` + processes & tmux gone -> settle to `sleeping` (and clear stale TUI status/pane cache).
 * - `requested` on a TUI session still alive past `STALE_PHASE_MS` (caller crashed before teardown)
 *   -> roll back to `awake` rather than killing a pane whose idle proof is stale.
 * - `waking` + fresh live process -> settle to `awake`.
 * - `waking` + tmux gone past `STALE_PHASE_MS` (without active wake) -> roll back to `sleeping`.
 */
export async function reconcileSleepRecord(
  m: MachineConfig,
  s: Session,
  options: {
    readonly activeWake?: boolean;
    readonly forceStaleRollback?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SleepRecord | null> {
  const initial = readSleepSafe(m, s);
  if (initial === null || initial.phase === 'sleeping' || initial.phase === 'awake') return initial;
  return withNativeAdmission(
    m,
    s,
    async () => {
      const current = readSleepSafe(m, s);
      if (current === null || current.phase === 'sleeping' || current.phase === 'awake') {
        return current;
      }
      const isNative = hasNativeRuntime(s);
      const staleMs = Date.now() - Date.parse(current.updatedAt);
      if (current.phase === 'requested') {
        const released = await processesReleasedAsync(current, options.signal);
        const tmuxAlive = await tmuxSessionAlive(m, s.name, options.signal);
        const tmuxGone = isNative ? tmuxAlive !== true : tmuxAlive === false;
        if (released && tmuxGone) {
          if (!isNative) {
            clearStatus(s.name);
            forgetAgentPane(m, s.name);
          }
          const settled: SleepRecord = {
            ...current,
            phase: 'sleeping',
            updatedAt: new Date().toISOString(),
          };
          await writeSleep(m, s, settled);
          return settled;
        }
        // TUI agents do not poll `ownerShouldSleep`: if the caller crashed before teardown and the
        // session stayed alive past STALE_PHASE_MS, roll back cleanly instead of wedging forever.
        if (!isNative && (options.forceStaleRollback === true || staleMs > STALE_PHASE_MS)) {
          const rolledBack: SleepRecord = {
            ...current,
            phase: 'awake',
            updatedAt: new Date().toISOString(),
          };
          await writeSleep(m, s, rolledBack);
          return rolledBack;
        }
        return current;
      }
      // phase === 'waking'
      const liveFresh = await sessionHasFreshLiveProcess(m, s, current, options.signal);
      if (liveFresh) {
        const settled: SleepRecord = {
          ...current,
          phase: 'awake',
          updatedAt: new Date().toISOString(),
        };
        await writeSleep(m, s, settled);
        return settled;
      }
      if (
        !options.activeWake &&
        (options.forceStaleRollback === true || staleMs > STALE_PHASE_MS)
      ) {
        const tmuxAlive = await tmuxSessionAlive(m, s.name, options.signal);
        const tmuxGone = isNative ? tmuxAlive !== true : tmuxAlive === false;
        if (tmuxGone) {
          const rolledBack: SleepRecord = {
            ...current,
            phase: 'sleeping',
            updatedAt: new Date().toISOString(),
          };
          await writeSleep(m, s, rolledBack);
          return rolledBack;
        }
      }
      return current;
    },
    options.signal,
  );
}
