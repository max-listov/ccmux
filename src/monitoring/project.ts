import { providerFor, lastActivityMs, lastTranscriptMessage, sessionModel } from "../agent/index.ts";
import { readLifecycle, readMetrics, resolveLiveState } from "../agent/sessionStatus.ts";
import { assistantEndedCurrentTurn, turnState } from "../chat/turnState.ts";
import { rcName } from "../config/machine.ts";
import { readLifecycleBlockForSession } from "../config/lifecycleBlocks.ts";
import { lastSignOfLife, type Observed } from "../events/observe.ts";
import type { MachineConfig, Session } from "../types.ts";
import type { MonitoringRow } from "./schema.ts";
import { hasNativeRuntime } from "../runtime/capabilities.ts";
import { managedRuntimeView } from "../runtime/view.ts";

/** Reuses the observation loop's captured pane and process-local transcript metadata caches. */
export function projectMonitoringRow(m: MachineConfig, s: Session, startedAt: number | undefined,
  pane: string | null, seen: Observed, now = Date.now()): MonitoringRow {
  const native = hasNativeRuntime(s) ? managedRuntimeView(m, s, now) : null;
  const running = startedAt !== undefined || native?.read.status === "live";
  const provider = providerFor(s);
  const scan = pane === null ? null : provider.scanPane(pane);
  const lifecycle = readLifecycle(s.name);
  const activity = lastActivityMs(s, m);
  const claimed = lifecycle?.state === "working" ? lifecycle.ts : null;
  const alive = lastSignOfLife(activity, seen.paneWorkingMs, claimed);
  const evidence = scan === null ? null : turnState({
    paneWorking: scan.state === "working",
    paneReady: provider.inspectChatPane === undefined || scan.ready,
    atMenu: scan.atPrompt !== null,
    endedOnAssistantText: assistantEndedCurrentTurn(lastTranscriptMessage(s, m), activity, claimed),
    msSinceActivity: alive === null ? null : now - alive,
  });
  const blocked = readLifecycleBlockForSession(m, s) !== null;
  const state: MonitoringRow["state"] = blocked ? "blocked" : !running ? "stopped"
    : native !== null ? native.read.status !== "live" || native.read.snapshot?.state === "unknown" ? "unknown"
      : native.atPrompt !== null ? "prompt" : native.state
    : scan?.atPrompt !== null && scan?.atPrompt !== undefined ? "prompt"
    : scan === null || (!scan.ready && scan.state === "indeterminate") ? "unknown"
    : resolveLiveState(scan.state, lifecycle, evidence);
  const metrics = running ? readMetrics(s.name) : null;
  const pct = metrics?.pct ?? scan?.context.percent ?? null;
  return {
    plane: "managed", name: s.name, agent: s.agent, uuid: s.uuid, rc: rcName(m, s.name),
    address: `${m.rcPrefix}:${s.name}`,
    dir: s.dir, archived: s.archived, running, state,
    model: running ? native?.read.snapshot?.nativeSelection?.model.model ?? sessionModel(s, m) : null,
    contextPercent: running && pct !== null && pct >= 0 && pct <= 100 ? pct : null,
    uptimeSeconds: startedAt === undefined ? null : Math.max(0, Math.floor(now / 1000 - startedAt)),
    lastActivityAt: activity === null ? null : new Date(activity).toISOString(),
    turnStartedAt: native !== null ? native.turnStartedAt : state === "working" && claimed !== null ? new Date(claimed).toISOString() : null,
    observedAt: new Date(now).toISOString(),
  };
}
