import { existsSync, readFileSync, statSync } from 'node:fs';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSdkSession } from 'stitchkit/agent-executor/claude-sdk';
import { findTranscriptInput } from 'stitchkit/agent-executor/claude-sdk';
import type { AgentMessagePart } from 'stitchkit/agent-runtime';
import { resolveMessageAttachments } from '../../../attachments/pins.ts';
import { nativeTranscriptPath } from '../../../context/claude.ts';
import { delegationStopped } from '../../../delegation/cancel.ts';
import {
  type RuntimeInput,
  readRuntimeInput,
  runtimeInputPath,
  writeRuntimeInput,
} from '../../../runtime/input.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { isRecord, str } from '../../transcript/normalize.ts';
import { claudeExecutorProfile } from './driver.ts';
import type { NativeProjection } from './projection.ts';

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
 * Legacy timestamp+text fallback for pre-UUID transcripts written before `clientId` reconciliation.
 */
export function nativeInputDelivered(
  m: MachineConfig,
  session: Session,
  input: RuntimeInput,
  dispatchedAt: string,
): boolean {
  let path: string;
  try {
    path = nativeTranscriptPath(session, m);
  } catch {
    return false;
  }
  if (!existsSync(path)) return false;
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

/**
 * Exact client-id reconciliation through `stitchkit/agent-executor/claude-sdk`'s `findInput`.
 * Matches only `type: 'user'` transcript entries carrying the exact submitted `uuid` across the
 * full transcript, without size truncation and without confusing assistant UUIDs for user inputs.
 */
export async function nativeInputFoundByClientId(
  m: MachineConfig,
  session: Session,
  input: Pick<RuntimeInput, 'messageId'>,
): Promise<boolean> {
  const nativeThreadId = session.nativeSession?.id;
  if (!nativeThreadId) return false;
  return await findTranscriptInput('claude-sdk', {
    profile: claudeExecutorProfile(m, session),
    cwd: session.dir,
    nativeThreadId,
    clientId: input.messageId,
  });
}

/** Resolve turn text + pinned image attachments into `AgentMessagePart[]` for `startTurn`. */
async function buildTurnParts(
  m: MachineConfig,
  session: Session,
  input: RuntimeInput,
  setResolvedFiles: (files: Map<string, Uint8Array>) => void,
): Promise<AgentMessagePart[]> {
  const references = input.images ?? [];
  if (references.length === 0) {
    setResolvedFiles(new Map());
    return [{ type: 'text', text: input.text }];
  }
  const resolved = await resolveMessageAttachments(
    m,
    session,
    input.messageId,
    references,
    AbortSignal.timeout(10_000),
  );
  if (resolved.length !== references.length)
    throw new Error(
      `Attached images are not retained: ${references.length} sent, ${resolved.length} resolved`,
    );
  const files = new Map<string, Uint8Array>();
  const parts: AgentMessagePart[] = [];
  for (const item of resolved) {
    files.set(item.reference.id, new Uint8Array(readFileSync(item.path)));
    parts.push({
      type: 'file',
      reference: item.reference.id,
      mediaType: item.reference.mediaType,
    });
  }
  parts.push({ type: 'text', text: input.text });
  setResolvedFiles(files);
  return parts;
}

/** What taking a turn off the mailbox touches in the owner that runs it. */
export interface PickupTarget {
  m: MachineConfig;
  session: Session;
  projection: NativeProjection;
  sdkSession: ClaudeSdkSession | null;
  selectModel: (model: string, turnId: string | null) => Promise<void>;
  setResolvedFiles: (files: Map<string, Uint8Array>) => void;
  startTurn: (input: {
    turnId: string;
    clientId: string;
    parts: AgentMessagePart[];
  }) => Promise<void>;
}

/** Takes queued turns off the session's mailbox and hands them to `ClaudeSdkSession`, one at a time. */
export class TurnPickup {
  /** The turn last handed over, so a tick never hands the same one twice. */
  private dispatched: string | null = null;

  private async reconcile(t: PickupTarget, input: RuntimeInput): Promise<void> {
    if (input.nativeId === this.dispatched) return;
    let found = await nativeInputFoundByClientId(t.m, t.session, input);
    let dispatchedAt = input.dispatchedAt;
    if (!found && input.receiptKind === undefined) {
      dispatchedAt ??= statSync(runtimeInputPath(t.m, t.session)).mtime.toISOString();
      found = nativeInputDelivered(t.m, t.session, input, dispatchedAt);
    }
    if (found) {
      this.dispatched = input.nativeId;
      await writeRuntimeInput(t.m, t.session, { ...input, phase: 'accepted' });
    } else if (input.phase !== 'uncertain') {
      await writeRuntimeInput(t.m, t.session, { ...input, dispatchedAt, phase: 'uncertain' });
    }
  }

  async run(t: PickupTarget): Promise<void> {
    const pending = readRuntimeInput(t.m, t.session);
    if (pending?.phase === 'dispatching' || pending?.phase === 'uncertain')
      await this.reconcile(t, pending);
    const input = readRuntimeInput(t.m, t.session);
    if (
      input &&
      input.phase === 'queued' &&
      input.nativeId !== this.dispatched &&
      t.projection.turn.status !== 'inProgress'
    ) {
      this.dispatched = input.nativeId;
      t.projection.turnId = input.nativeId;
      t.projection.turnStartedAt = new Date().toISOString();
      t.projection.turn = { ...t.projection.turn, status: 'inProgress', state: 'working' };
      await writeRuntimeInput(t.m, t.session, {
        ...input,
        phase: 'dispatching',
        receiptKind: 'client-id',
        dispatchedAt: t.projection.turnStartedAt,
      });
      const options = input.turnOptions?.options;
      if (options?.runtime === 'claude') {
        if (options.model.model !== t.projection.selection?.model.model)
          await t.selectModel(options.model.model, input.nativeId);
        if (options.effort !== undefined)
          await t.sdkSession?.applyFlagSettings({
            effortLevel: options.effort as EffortLevel,
          });
      }
      if (delegationStopped(t.m, t.session)) throw new Error('Delegated work has ended');
      const parts = await buildTurnParts(t.m, t.session, input, t.setResolvedFiles);
      await t.startTurn({
        turnId: input.nativeId,
        clientId: input.messageId,
        parts,
      });
      await writeRuntimeInput(t.m, t.session, { ...input, phase: 'accepted' });
    }
  }
}
