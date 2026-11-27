import {
  lastActivityMs,
  lastTranscriptMessage,
  providerFor,
  sessionModel,
  transcriptMtimeMs,
} from '../agent/index.ts';
import { assistantEndedCurrentTurn, turnState } from '../chat/turnState.ts';
import { rcName } from '../config/machine.ts';
import { lastSignOfLife, type Observed } from '../events/observe.ts';
import { selfAddress } from '../fleet/address.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { latestActivityMs, managedRuntimeView } from '../runtime/view.ts';
import { readLifecycleBlockForSession } from '../session/lifecycleBlocks.ts';
import { sleepBlocksStart } from '../session/sleep/store.ts';
import {
  readLifecycle,
  readMetrics,
  readWaiting,
  renderRate,
  resolveLiveState,
} from '../session/status.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../types.ts';
import { measured } from '../util/cpuScope.ts';
import type { MonitoringRow, MonitoringStep } from './schema.ts';

function boundedText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Structural shape of the last transcript entry — shared by monitoring rows and inventory rows. */
export function monitoringStepOf(
  running: boolean,
  message: Pick<TranscriptMessage, 'kind' | 'role' | 'toolName' | 'createdAt'> | null,
): MonitoringStep | null {
  if (!running || message === null) return null;
  return {
    kind: message.kind,
    role: message.role,
    toolName: boundedText(message.toolName, 256),
    at: boundedText(message.createdAt, 64),
  };
}

/** Reuses the observation loop's captured pane and process-local transcript metadata caches. */
function projectMonitoringRowImpl(
  m: MachineConfig,
  s: Session,
  startedAt: number | undefined,
  pane: string | null,
  seen: Observed,
  now = Date.now(),
  memoryBytes?: number | null,
): MonitoringRow {
  const native = hasNativeRuntime(s) ? managedRuntimeView(m, s, now) : null;
  const running = startedAt !== undefined || native?.read.status === 'live';
  const provider = providerFor(s);
  const scan = pane === null ? null : provider.scanPane(pane);
  const lifecycle = readLifecycle(s.name);
  const lastMessage = running ? lastTranscriptMessage(s, m) : null;
  const fileMtime = transcriptMtimeMs(s, m);
  const activity = latestActivityMs(lastActivityMs(s, m), native?.activity.atMs ?? null);
  const claimed = lifecycle?.state === 'working' ? lifecycle.ts : null;
  const alive = lastSignOfLife(fileMtime, seen.paneWorkingMs, claimed);
  const evidence =
    scan === null
      ? null
      : turnState({
          paneWorking: scan.state === 'working',
          paneReady: provider.inspectChatPane === undefined || scan.ready,
          atMenu: scan.atPrompt !== null,
          endedOnAssistantText: assistantEndedCurrentTurn(lastMessage, fileMtime, claimed),
          msSinceActivity: alive === null ? null : now - alive,
        });
  const blocked = readLifecycleBlockForSession(m, s) !== null;
  const state: MonitoringRow['state'] = blocked
    ? 'blocked'
    : !running
      ? 'stopped'
      : native !== null
        ? native.read.status !== 'live' || native.read.snapshot?.state === 'unknown'
          ? 'unknown'
          : native.atPrompt !== null
            ? 'prompt'
            : native.state
        : scan?.atPrompt !== null && scan?.atPrompt !== undefined
          ? 'prompt'
          : scan === null || (!scan.ready && scan.state === 'indeterminate')
            ? 'unknown'
            : resolveLiveState(scan.state, lifecycle, evidence);
  const metrics = running ? readMetrics(s.name) : null;
  const pct = metrics?.pct ?? scan?.context.percent ?? null;
  const prompt = native !== null ? native.atPrompt : (scan?.atPrompt ?? null);
  const waitingTarget = running ? (readWaiting(s.name, now)?.target ?? null) : null;
  const sleeping = !s.archived && !running && sleepBlocksStart(m, s);
  return {
    plane: 'managed',
    name: s.name,
    agent: s.agent,
    uuid: s.uuid,
    rc: rcName(m, s.name),
    address: selfAddress(m, s.name),
    dir: s.dir,
    archived: s.archived,
    running,
    state,
    sleeping,
    pinned: s.pinned === true,
    memoryBytes: running ? (memoryBytes ?? null) : 0,
    registrationGeneration: s.registrationGeneration ?? null,
    model: running
      ? (native?.read.snapshot?.nativeSelection?.model.model ?? sessionModel(s, m))
      : null,
    contextPercent: running && pct !== null && pct >= 0 && pct <= 100 ? pct : null,
    statusLineRendersPerMinute: renderRate([metrics], now)?.perMinute ?? null,
    uptimeSeconds: startedAt === undefined ? null : Math.max(0, Math.floor(now / 1000 - startedAt)),
    startedAt: startedAt === undefined ? null : new Date(startedAt * 1000).toISOString(),
    lastActivityAt: activity === null ? null : new Date(activity).toISOString(),
    turnStartedAt:
      native !== null
        ? native.turnStartedAt
        : state === 'working' && claimed !== null
          ? new Date(claimed).toISOString()
          : null,
    step: monitoringStepOf(running, lastMessage ?? native?.activity.step ?? null),
    atPrompt: running ? boundedText(prompt, 256) : null,
    waitingFor: running ? boundedText(waitingTarget, 256) : null,
    observedAt: new Date(now).toISOString(),
  };
}

export const projectMonitoringRow = measured(projectMonitoringRowImpl);
