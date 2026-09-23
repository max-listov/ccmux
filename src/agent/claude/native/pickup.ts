import { existsSync, readFileSync, statSync } from 'node:fs';
import type { EffortLevel, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { nativeTranscriptPath } from '../../../context/claude.ts';
import {
  type RuntimeInput,
  readRuntimeInput,
  runtimeInputPath,
  writeRuntimeInput,
} from '../../../runtime/input.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { isRecord, str } from '../../transcript/normalize.ts';
import type { NativeProjection } from './projection.ts';
import type { PromptQueue } from './promptQueue.ts';
import { turnContent } from './turnContent.ts';

function textsOf(entry: unknown): string[] {
  if (!isRecord(entry) || str(entry.type) !== 'user') return [];
  const message = isRecord(entry.message) ? entry.message : null;
  const content = message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!isRecord(item) || str(item.type) !== 'text') return [];
    const text = str(item.text);
    return text === null ? [] : [text];
  });
}

/**
 * Whether a turn whose dispatch was cut short actually reached the conversation.
 *
 * The phase file says `dispatching`, which means the process died between pushing the turn and
 * recording that it had. That question has exactly one honest answer, and it is not in our files:
 * it is whether the runtime's own transcript contains the turn. Asked against the transcript rather
 * than assumed either way, because both assumptions lose something — assuming delivered drops a
 * message nobody sent, assuming undelivered sends a second copy of one already answered.
 *
 * Bounded in time as well as by text: the same words sent twice an hour apart are two turns, and
 * matching on text alone would read the older one as a receipt for the newer. The bound comes from
 * the record when it carries one and from the mailbox file's own timestamp when it does not — a
 * record written before that field existed still knows when it was written.
 */
export function nativeInputDelivered(
  session: Session,
  input: RuntimeInput,
  dispatchedAt: string,
): boolean {
  let path: string;
  try {
    path = nativeTranscriptPath(session);
  } catch {
    return false;
  }
  // Absent is "not delivered", not "unknown": a conversation the runtime never wrote cannot hold
  // a turn it never received.
  if (!existsSync(path)) return false;
  // Every line since the dispatch, not a fixed tail: a turn that was delivered and then produced
  // hundreds of tool lines before the crash would have scrolled out of any window measured in
  // lines, and been judged undelivered — which sends it a second time.
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const at = isRecord(parsed) ? str(parsed.timestamp) : null;
    if (at === null || at < dispatchedAt) continue;
    if (textsOf(parsed).includes(input.text)) return true;
  }
  return false;
}

/** What taking a turn off the mailbox touches in the owner that runs it. */
export interface PickupTarget {
  m: MachineConfig;
  session: Session;
  projection: NativeProjection;
  queue: PromptQueue;
  query: Query | null;
  selectModel: (model: string, turnId: string | null) => Promise<void>;
}

/** Takes queued turns off the session's mailbox and hands them to the runtime, one at a time. */
export class TurnPickup {
  /** The turn last handed over, so a tick never hands the same one twice. */
  private dispatched: string | null = null;

  /**
   * Adopt a dispatch the previous process did not finish recording.
   *
   * `dispatching` is written before the turn is queued and `accepted` after, so a process that
   * dies between them leaves a phase no later tick would look at again — the turn sat there and
   * the sender waited for an acknowledgement that could never come. The runtime's own transcript
   * decides which of the two happened; this only acts on the answer.
   */
  private async reconcile(t: PickupTarget, input: RuntimeInput): Promise<void> {
    if (input.nativeId === this.dispatched) return;
    // A record written before the dispatch time was carried still knows when it was written: the
    // mailbox file's own timestamp is that moment. Without this the whole population this fix
    // exists for — the sessions already parked by an earlier build — would be judged undelivered
    // and sent a second time, which is the harm the reconciliation is meant to avoid.
    const dispatchedAt =
      input.dispatchedAt ?? statSync(runtimeInputPath(t.m, t.session)).mtime.toISOString();
    if (nativeInputDelivered(t.session, input, dispatchedAt)) {
      this.dispatched = input.nativeId;
      await writeRuntimeInput(t.m, t.session, { ...input, phase: 'accepted' });
      return;
    }
    // Back to the queue rather than failed: nothing was sent, so the turn is exactly as unsent as
    // it was before, and the next tick dispatches it normally.
    await writeRuntimeInput(t.m, t.session, { ...input, phase: 'queued' });
  }

  async run(t: PickupTarget): Promise<void> {
    const pending = readRuntimeInput(t.m, t.session);
    if (pending?.phase === 'dispatching') await this.reconcile(t, pending);
    const input = readRuntimeInput(t.m, t.session);
    if (
      input &&
      input.phase === 'queued' &&
      input.nativeId !== this.dispatched &&
      // One turn at a time. Dispatching a second while the first runs retags its items, lets its
      // result close the wrong turn, and points an interrupt at a turn that is not running.
      t.projection.turn.status !== 'inProgress'
    ) {
      this.dispatched = input.nativeId;
      t.projection.turnId = input.nativeId;
      t.projection.turnStartedAt = new Date().toISOString();
      t.projection.turn = { ...t.projection.turn, status: 'inProgress', state: 'working' };
      // `dispatching` before the queue, `accepted` after: a crash between the two is then visible as
      // an in-flight dispatch rather than as a delivered message that never arrived.
      await writeRuntimeInput(t.m, t.session, {
        ...input,
        phase: 'dispatching',
        dispatchedAt: t.projection.turnStartedAt,
      });
      const options = input.turnOptions?.options;
      if (options?.runtime === 'claude') {
        // A turn's own model and effort, applied before it is queued so they govern this turn rather
        // than the one after it.
        if (options.model.model !== t.projection.selection?.model.model)
          await t.selectModel(options.model.model, input.nativeId);
        // The runtime has no per-turn effort setter: `applyFlagSettings` sets it for the rest of
        // the session on models that accept it. Applied here so the turn that asked for it is the
        // first one governed by it, and stated as session-scoped rather than pretended per-turn.
        if (options.effort !== undefined)
          // The level came from this runtime's own catalog and was checked against it before the
          // turn was admitted, so it is a name the runtime published — the cast restates that,
          // rather than narrowing it here to a list this file would then have to keep current.
          await t.query?.applyFlagSettings?.({
            effortLevel: options.effort as EffortLevel,
          });
      }
      t.queue.push({
        type: 'user',
        session_id: t.session.nativeSession?.id ?? '',
        parent_tool_use_id: null,
        message: { role: 'user', content: await turnContent(t.m, t.session, input) },
      } as SDKUserMessage);
      await writeRuntimeInput(t.m, t.session, { ...input, phase: 'accepted' });
    }
  }
}
