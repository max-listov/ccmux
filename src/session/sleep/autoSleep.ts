import { AppError } from 'stitchkit';
import { lastActivityMs, transcriptMtimeMs } from '../../agent/index.ts';
import { managedPeer } from '../../chat/identity.ts';
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
import { previewSleep, sleepSessionByName } from './operations.ts';
import type { SleepIdleReceipt } from './schema.ts';
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

/** Refusals that keep a session awake by design rather than by failure. */
const SKIP_CODES = new Set([
  'NOT_IDLE',
  'PINNED_SESSION',
  'MIN_AWAKE_PER_PROFILE',
  'PROFILE_UNAVAILABLE',
  'REVISION_CONFLICT',
  'SLEEP_PENDING',
  'UNSUPPORTED',
]);

/**
 * One pass over this machine's sessions: every running, non-delegated Claude or Codex session idle
 * at least `idleAfterMs`, oldest first, is put to sleep (or, with `dryRun`, decided without being
 * touched) under the same policy as a single `session.sleep`. Returns a receipt for each session the
 * pass considered. The daemon's opt-in auto-sleep and `session.sleep-idle` are both this pass.
 *
 * `deadlineMs` bounds the pass: a candidate not reached by then is `not-attempted`, so a caller with a
 * transport budget gets every answer back rather than a timeout.
 */
export async function sleepIdleSessions(
  m: MachineConfig,
  options: {
    readonly idleAfterMs: number;
    readonly dryRun: boolean;
    readonly now?: number;
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
    readonly paneWorkingMs?: ReadonlyMap<string, number>;
  },
): Promise<SleepIdleReceipt[]> {
  const now = options.now ?? Date.now();
  const sessions = loadSessions(m);
  const liveness = await listAgentLiveness(m);
  const receipts: SleepIdleReceipt[] = [];
  const receipt = (
    s: Session,
    outcome: SleepIdleReceipt['outcome'],
    code: string | null = null,
    reason: string | null = null,
  ) => receipts.push({ target: managedPeer(m.rcPrefix, s), outcome, code, reason });
  const candidates: Array<{ session: Session; idleAnchorMs: number }> = [];

  for (const s of sessions) {
    options.signal?.throwIfAborted();
    if (s.archived || s.delegation !== undefined) continue;
    if (s.agent !== 'claude' && s.agent !== 'codex') continue;
    if (sleepBlocksStart(m, s)) continue;

    const native = hasNativeRuntime(s);
    // Liveness is read at this moment; `now` only places the idle threshold.
    const live = native
      ? readManagedRuntimeStatus(m, s).status === 'live'
      : liveness.live.has(s.name);
    if (!live) continue;
    if (readLifecycleBlockForSession(m, s) !== null) {
      receipt(s, 'skipped', 'SESSION_BLOCKED', 'The session is blocked until it is repaired');
      continue;
    }

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
    // Fail-closed: unmeasurable idle time never qualifies.
    if (anchor === null) {
      receipt(s, 'skipped', 'NOT_IDLE', 'Its idle time cannot be measured');
      continue;
    }
    if (now - anchor < options.idleAfterMs) continue;
    if (s.pinned === true) {
      receipt(s, 'skipped', 'PINNED_SESSION', 'The session is pinned awake');
      continue;
    }
    candidates.push({ session: s, idleAnchorMs: anchor });
  }

  // Oldest idle first, so the profile's minimum keeps the freshest sessions awake.
  candidates.sort(
    (a, b) => a.idleAnchorMs - b.idleAnchorMs || a.session.name.localeCompare(b.session.name),
  );

  const sharedRows =
    candidates.length > 0 && !options.dryRun ? await processSnapshotAsync(options.signal) : null;
  const assumed = new Set<string>();
  for (const { session } of candidates) {
    options.signal?.throwIfAborted();
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      receipt(session, 'not-attempted', null, 'The pass ran out of its time budget first');
      continue;
    }
    try {
      if (options.dryRun) {
        const verdict = await previewSleep(
          m,
          session,
          assumed,
          options.signal ?? AbortSignal.timeout(30_000),
        );
        if ('allowed' in verdict) {
          assumed.add(session.name);
          receipt(session, 'would-sleep');
        } else receipt(session, 'skipped', verdict.code, verdict.reason);
        continue;
      }
      const slept = await sleepSessionByName(m, session.name, {
        forcePolicy: false,
        ...(sharedRows === null ? {} : { rows: sharedRows }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (slept.state === 'sleeping') receipt(session, 'slept');
      else receipt(session, 'skipped', 'UNSUPPORTED', 'The runtime does not release on sleep');
    } catch (error) {
      if (error instanceof AppError)
        receipt(
          session,
          SKIP_CODES.has(error.code) ? 'skipped' : 'refused',
          error.code,
          error.message.slice(0, 1024),
        );
      else receipt(session, 'refused', 'UNAVAILABLE', String(error).slice(0, 1024));
    }
  }
  return receipts.slice(0, 256);
}

/** The daemon's opt-in auto-sleep pass: `sleepIdleSessions` with the machine's own settings. */
export async function runAutoSleepPass(
  m: MachineConfig,
  options: {
    readonly now?: number;
    readonly signal?: AbortSignal;
    readonly paneWorkingMs?: ReadonlyMap<string, number>;
  } = {},
): Promise<{ readonly slept: readonly string[] }> {
  if (!m.idleSleep.enabled) return { slept: [] };
  const receipts = await sleepIdleSessions(m, {
    idleAfterMs: m.idleSleep.idleAfterMinutes * 60_000,
    dryRun: false,
    ...options,
  });
  const slept: string[] = [];
  for (const row of receipts) {
    if (row.outcome === 'slept') {
      slept.push(row.target.session);
      log.info({ msg: 'auto-sleep: put idle session to sleep', name: row.target.session });
    } else if (row.outcome === 'refused')
      log.warn({
        msg: 'auto-sleep: failed for candidate',
        name: row.target.session,
        code: row.code,
      });
    else log.debug({ msg: 'auto-sleep: skipped', name: row.target.session, code: row.code });
  }
  return { slept };
}
