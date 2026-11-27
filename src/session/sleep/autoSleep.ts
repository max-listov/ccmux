import { AppError } from 'stitchkit';
import { lastActivityMs, transcriptMtimeMs } from '../../agent/index.ts';
import { processSnapshotAsync } from '../../external/processes.ts';
import { hasNativeRuntime } from '../../runtime/modes.ts';
import { readManagedRuntimeStatus } from '../../runtime/status.ts';
import { listAgentLiveness } from '../../tmux/agentPane.ts';
import { lastClientActivityMs } from '../../tmux/tmux.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { log } from '../../util/log.ts';
import { readLifecycleBlockForSession } from '../lifecycleBlocks.ts';
import { loadSessions } from '../registry.ts';
import { readLifecycle } from '../status.ts';
import { sleepSessionByName } from './operations.ts';
import { readSleepSafe, sleepBlocksStart } from './store.ts';

/**
 * Opt-in idle auto-sleep pass for the daemon.
 *
 * Strictly inactive unless `m.idleSleep.enabled === true`. Uses a conservative idle anchor that
 * includes start/wake timestamps and tmux client activity so a freshly woken session with an old
 * transcript or a brand-new empty session always gets a full `idleAfterMinutes` grace window.
 */

export interface IdleAnchorInputs {
  readonly lastActivityMs: number | null;
  readonly transcriptMtimeMs: number | null;
  readonly startedAtMs: number | null;
  readonly awakeAtMs: number | null;
  readonly paneWorkingMs: number | null;
  readonly lifecycleTs: number | null;
  readonly clientActivityMs: number | null;
}

/**
 * Compute the latest observable sign of activity/wake/start across all clocks.
 * Returns `null` (fail-closed — never auto-sleep) when every clock is absent or unparseable.
 */
export function computeIdleAnchorMs(inputs: IdleAnchorInputs): number | null {
  const values = [
    inputs.lastActivityMs,
    inputs.transcriptMtimeMs,
    inputs.startedAtMs,
    inputs.awakeAtMs,
    inputs.paneWorkingMs,
    inputs.lifecycleTs,
    inputs.clientActivityMs,
  ];
  let best: number | null = null;
  for (const value of values) {
    if (value !== null && Number.isFinite(value) && value > 0) {
      if (best === null || value > best) best = value;
    }
  }
  return best;
}

const EXPECTED_SKIP_CODES = new Set([
  'NOT_IDLE',
  'PINNED_SESSION',
  'MIN_AWAKE_PER_PROFILE',
  'PROFILE_UNAVAILABLE',
  'REVISION_CONFLICT',
  'SLEEP_PENDING',
  'UNSUPPORTED',
]);

export async function runAutoSleepPass(
  m: MachineConfig,
  options: {
    readonly now?: number;
    readonly signal?: AbortSignal;
    readonly paneWorkingMs?: ReadonlyMap<string, number>;
  } = {},
): Promise<{ readonly slept: readonly string[] }> {
  if (!m.idleSleep.enabled) return { slept: [] };
  const now = options.now ?? Date.now();
  const thresholdMs = m.idleSleep.idleAfterMinutes * 60_000;
  const sessions = loadSessions(m);
  const liveness = await listAgentLiveness(m);
  const candidates: Array<{ session: Session; idleAnchorMs: number }> = [];

  for (const s of sessions) {
    options.signal?.throwIfAborted();
    if (s.archived || s.pinned === true || s.delegation !== undefined) continue;
    if (s.agent !== 'claude' && s.agent !== 'codex') continue;
    if (sleepBlocksStart(m, s) || readLifecycleBlockForSession(m, s) !== null) continue;

    const native = hasNativeRuntime(s);
    const live = native
      ? readManagedRuntimeStatus(m, s, now).status === 'live'
      : liveness.live.has(s.name);
    if (!live) continue;

    const sleep = readSleepSafe(m, s);
    const awakeAtRaw = sleep?.phase === 'awake' ? Date.parse(sleep.updatedAt) : Number.NaN;
    const awakeAtMs = Number.isFinite(awakeAtRaw) ? awakeAtRaw : null;
    const startedSec = liveness.startedAt.get(s.name);
    const startedAtMs = startedSec !== undefined ? startedSec * 1000 : null;
    const hasTerminal = !native || (s.agent === 'codex' && s.delegation === undefined);
    const clientActivityMs = hasTerminal ? await lastClientActivityMs(m, s.name) : null;
    const anchor = computeIdleAnchorMs({
      lastActivityMs: lastActivityMs(s, m),
      transcriptMtimeMs: transcriptMtimeMs(s, m),
      startedAtMs,
      awakeAtMs,
      paneWorkingMs: options.paneWorkingMs?.get(s.name) ?? null,
      lifecycleTs: readLifecycle(s.name)?.ts ?? null,
      clientActivityMs,
    });
    // Fail-closed: unmeasurable idle time never qualifies for auto-sleep.
    if (anchor === null || now - anchor < thresholdMs) continue;
    candidates.push({ session: s, idleAnchorMs: anchor });
  }

  // Deterministic order: oldest idle sessions first so profile keepalive retains the freshest ones.
  candidates.sort(
    (a, b) => a.idleAnchorMs - b.idleAnchorMs || a.session.name.localeCompare(b.session.name),
  );

  const sharedRows = candidates.length > 0 ? await processSnapshotAsync(options.signal) : null;
  const slept: string[] = [];
  for (const { session } of candidates) {
    options.signal?.throwIfAborted();
    try {
      const receipt = await sleepSessionByName(m, session.name, {
        forcePolicy: false,
        ...(sharedRows === null ? {} : { rows: sharedRows }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (receipt.state === 'sleeping') {
        slept.push(session.name);
        log.info({ msg: 'auto-sleep: put idle session to sleep', name: session.name });
      }
    } catch (error) {
      if (error instanceof AppError && EXPECTED_SKIP_CODES.has(error.code)) {
        log.debug({
          msg: 'auto-sleep: skipped candidate',
          name: session.name,
          code: error.code,
          reason: error.message,
        });
        continue;
      }
      log.warn({ msg: 'auto-sleep: failed for candidate', name: session.name, err: String(error) });
    }
  }
  return { slept };
}
