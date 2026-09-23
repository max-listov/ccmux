import {
  type AgentProvider,
  lastActivityMs,
  lastTranscriptMessage,
  readTranscript,
} from '../agent/index.ts';
import { lastSignOfLife } from '../events/observe.ts';
import { paneWorkingSince } from '../events/paneActivity.ts';
import { readLifecycle } from '../session/status.ts';
import type {
  ChatMessage,
  ChatTarget,
  MachineConfig,
  Session,
  TranscriptMessage,
} from '../types.ts';
import { stripAnsi } from '../util/ansi.ts';
import { appendAck } from './ackLog.ts';
import { type loadCursors, saveCursors } from './cursors.ts';
import { isConditional } from './settlement.ts';
import { assistantEndedCurrentTurn, type TurnState, turnState } from './turnState.ts';

/**
 * Gather what `turnState` needs from this session's pane and transcript. The IO lives here so the
 * decision itself stays pure and testable — the previous version was neither, which is how it
 * shipped waiting on an event that a killed turn can never produce.
 *
 * Silence is the evidence a turn is over, and the transcript is only half of what silence means. A
 * session four minutes into a tool call writes nothing while its pane is plainly working, so the
 * supervisor's record of when each pane was last seen working counts as activity beside the
 * transcript's own mtime. Without it, one look at the pane in the gap between a tool finishing and
 * its result being written reads as a turn nobody is coming back to — and `ccmux wait`, which is a
 * fresh process with no memory of its own, would answer "done" about a session mid-work.
 */
export function readTurnState(
  m: MachineConfig,
  s: Session,
  provider: AgentProvider,
  pane: string,
  nowMs: number,
  injected?: { turnStartedMs: number; assistantAnswered: boolean },
): TurnState {
  const plain = stripAnsi(pane);
  const scan = provider.scanPane(plain);
  const inspection = provider.inspectChatPane?.(pane);
  const lm = lastTranscriptMessage(s, m);
  const activity = lastActivityMs(s, m);
  const lifecycle = readLifecycle(s.name);
  const turnStartedMs =
    injected?.turnStartedMs ?? (lifecycle?.state === 'working' ? lifecycle.ts : null);
  const mt = lastSignOfLife(
    activity,
    scan.state === 'working' ? nowMs : paneWorkingSince(m, s.name),
    turnStartedMs,
  );
  return turnState({
    paneWorking: scan.state === 'working',
    // `ready` is a HARD gate here, so it may only be trusted from a provider whose pane detectors are
    // calibrated. `chatDeliverable` is that marker: an agent that can say "this pane is safe to type
    // into" has had its chrome mapped; one that cannot has not. Treating an unreliable "not drawn" as
    // a permanent block would recreate the very hang this change removes, on another agent.
    paneReady: provider.inspectChatPane === undefined ? true : scan.ready,
    atMenu: scan.atPrompt !== null,
    paneBlock:
      inspection?.state === 'input-busy'
        ? 'input-occupied'
        : inspection?.state === 'unknown'
          ? 'unknown-pane'
          : null,
    endedOnAssistantText:
      injected?.assistantAnswered ?? assistantEndedCurrentTurn(lm, activity, turnStartedMs),
    msSinceActivity: mt === null ? null : nowMs - mt,
  });
}

export type ChatTurnProgress = 'awaiting-pickup' | 'running' | 'answered' | 'interrupted';

export function chatTurnProgressFromMessages(
  messages: readonly TranscriptMessage[],
  messageId: string,
): ChatTurnProgress {
  const marker = `id: ${messageId}`;
  let pickedUp = false;
  let lastAfterPickup: TranscriptMessage | null = null;
  for (const message of messages) {
    if (
      !pickedUp &&
      message.role === 'user' &&
      message.kind === 'message' &&
      message.text?.includes(marker) === true
    ) {
      pickedUp = true;
      continue;
    }
    if (pickedUp) lastAfterPickup = message;
  }
  if (!pickedUp) return 'awaiting-pickup';
  if (
    lastAfterPickup?.role === 'system' &&
    lastAfterPickup.text?.includes('<turn_aborted>') === true
  )
    return 'interrupted';
  return lastAfterPickup?.role === 'assistant' && lastAfterPickup.kind === 'message'
    ? 'answered'
    : 'running';
}

export type PickupRecord = { messageId: string; transcriptLine?: number | undefined };

export type PickupRead = { totalLines: number; messages: TranscriptMessage[] };

/**
 * Pickup progress from the transcript lines written since the letter was injected.
 *
 * Everything after that line is read — a tool-heavy turn may put thousands of records between the
 * marker and the answer — and nothing before it. Reading the whole history instead parsed every
 * record of the session on each delivery pass while a turn ran: on a transcript of a gigabyte, a
 * few seconds of CPU and gigabytes of memory per pass, on the daemon's one event loop. A transcript
 * now shorter than that line was rewritten, so it is searched from the first line once rather than
 * reporting a pickup that has not happened, which would inject the same letter again.
 */
export function pickupProgressFrom(
  readFrom: (cursor: number) => PickupRead,
  pickup: PickupRecord,
): ChatTurnProgress {
  const from = pickup.transcriptLine ?? 0;
  let read = readFrom(from);
  if (read.totalLines < from) read = readFrom(0);
  return chatTurnProgressFromMessages(read.messages, pickup.messageId);
}

export function chatTurnProgress(
  m: MachineConfig,
  s: Session,
  pickup: PickupRecord,
): ChatTurnProgress {
  return pickupProgressFrom(
    (cursor) => readTranscript(s, m, { tail: Number.MAX_SAFE_INTEGER, cursor }),
    pickup,
  );
}

/** The transcript's line count now: a letter injected next appears after it. */
export function transcriptLineCount(m: MachineConfig, s: Session): number | undefined {
  const read = readTranscript(s, m, { tail: 1 });
  return read.available ? read.totalLines : undefined;
}

type Pickup = ReturnType<typeof loadCursors>['pickups'][string];

/**
 * Persisted pre-submit transition. Cursor and pickup move in one atomic cursors-file write.
 *
 * `proof` is where pickup will be proved from: the transcript line a hookless pane provider was at,
 * or a native runtime's turn binding, which starts as an intent and is accepted by the runtime.
 */
export function armPickup(
  cursors: ReturnType<typeof loadCursors>,
  recipientKey: string,
  pick: { msg: ChatMessage; idx: number },
  injectedAt: string,
  proof: { transcriptLine?: number | undefined; native?: Pickup['native'] } = {},
): void {
  const conditional = isConditional(pick.msg);
  cursors.pickups[recipientKey] = {
    messageId: pick.msg.id,
    injectedAt,
    ledgerIndex: pick.idx,
    conditional,
    ...(proof.transcriptLine === undefined ? {} : { transcriptLine: proof.transcriptLine }),
    ...(proof.native === undefined ? {} : { native: proof.native }),
  };
  if (!conditional) {
    cursors.delivered[recipientKey] = pick.idx + 1;
    cursors.read[recipientKey] = Math.max(cursors.read[recipientKey] ?? 0, pick.idx + 1);
  }
}

/**
 * Close the pickup the recipient has taken up, and persist it: a conditional letter is acknowledged,
 * an immediate one's cursors stand past it. Arming already moved them; this repeats it with `max` so
 * a pickup armed by an earlier version, which did not, still ends where it should.
 */
export async function finishPickup(
  m: MachineConfig,
  cursors: ReturnType<typeof loadCursors>,
  recipientKey: string,
  recipient: ChatTarget,
): Promise<void> {
  const pickup = cursors.pickups[recipientKey];
  if (pickup === undefined) return;
  if (pickup.conditional) appendAck(m, pickup.messageId, 'daemon', recipient);
  else if (pickup.ledgerIndex !== null) {
    const past = pickup.ledgerIndex + 1;
    cursors.delivered[recipientKey] = Math.max(cursors.delivered[recipientKey] ?? 0, past);
    cursors.read[recipientKey] = Math.max(cursors.read[recipientKey] ?? 0, past);
  }
  const { [recipientKey]: _finished, ...remaining } = cursors.pickups;
  cursors.pickups = remaining;
  await saveCursors(m, cursors);
}
