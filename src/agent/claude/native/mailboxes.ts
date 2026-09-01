import type { Query } from '@anthropic-ai/claude-agent-sdk';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../../runtime/interrupt.ts';
import { readRuntimeMcpRequest, writeRuntimeMcpRequest } from '../../../runtime/mcpControl.ts';
import { readRuntimeRewind, writeRuntimeRewind } from '../../../runtime/rewind.ts';
import { RewindResultSchema } from '../../../runtime/rewindSchema.ts';
import {
  readRuntimeMode,
  shouldRestoreMode,
  writeRuntimeMode,
} from '../../../runtime/sessionMode.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import {
  clearNativeCommand,
  readNativeCommand,
  readNativeReceipt,
  writeNativeReceipt,
} from '../../codex/ownedControl.ts';
import { type Discovery, refreshMcpServers } from './discovery.ts';
import type { PendingApproval } from './owner.ts';
import { permissionResult } from './permission.ts';
import type { NativeProjection } from './projection.ts';
import { advanceTurn } from './turn.ts';

/**
 * Everything a caller can ask a live session to DO, other than take a turn.
 *
 * Six requests, one shape: read the mailbox, refuse what this conversation cannot answer, act on
 * the runtime, and write back what happened. The shared half of that shape — the waiting, the
 * identity check, the retry receipt — belongs to the caller's side in `runtime/mailbox.ts`; this
 * is the session's side of the same four files, plus the two that answer an operator directly.
 */
export interface Mailboxes {
  m: MachineConfig;
  session: Session;
  query: Query | null;
  projection: NativeProjection;
  discovery: Discovery;
  pending: Map<string, PendingApproval>;
  publish: () => Promise<void>;
  report: (error: unknown) => Promise<void>;
  settleAll: (decision: 'cancel' | 'decline') => void;
}

/** Apply one decision the control plane wrote, and acknowledge it. */
export async function applyResponse(o: Mailboxes): Promise<void> {
  const command = readNativeCommand(o.m, o.session.name);
  if (!command) return;
  const prior = readNativeReceipt(o.m, o.session.name);
  if (prior?.operationId === command.operationId) {
    clearNativeCommand(o.m, o.session.name);
    return;
  }
  const receipt = (outcome: 'submitted' | 'rejected' | 'uncertain', reason: string | null) =>
    writeNativeReceipt(o.m, o.session.name, {
      operationId: command.operationId,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      outcome,
      reason,
    });
  const waiting = o.pending.get(command.requestId);
  if (
    command.generation !== o.session.registrationGeneration ||
    !waiting ||
    command.kind !== 'approval' ||
    command.decision === null
  ) {
    // Refused rather than guessed: a response that does not match a request this runtime holds
    // would otherwise resume some other turn, or none.
    await receipt('rejected', 'request-identity-mismatch');
    clearNativeCommand(o.m, o.session.name);
    return;
  }
  // Written BEFORE the effect. A crash in the window then reads as uncertain, which is the truth;
  // writing only afterwards reported an applied decision as rejected on the next start.
  await receipt('uncertain', null);
  o.pending.delete(command.requestId);
  waiting.settle(permissionResult(command.decision, { toolName: waiting.toolName }));
  o.projection.turn = advanceTurn(o.projection.turn, { step: 'answered' });
  o.projection.content?.buffer.lifecycle(
    'request',
    waiting.request.turnId,
    command.requestId,
    command.decision,
  );
  o.projection.content?.publish();
  await receipt('submitted', null);
  clearNativeCommand(o.m, o.session.name);
  await o.publish();
}

/**
 * Cancel the running turn, leaving the runtime alive to answer for it.
 *
 * Outstanding permissions are settled with a cancel rather than abandoned: the runtime is holding
 * those callbacks, and interrupting behind their backs leaves them unresolved for the life of the
 * process while the snapshot claims the session is idle.
 */
export async function applyInterrupt(o: Mailboxes): Promise<void> {
  const command = readRuntimeInterrupt(o.m, o.session);
  if (command === null || !['queued', 'uncertain'].includes(command.phase)) return;
  const cancellable = () =>
    isCancellableTurn(
      {
        generation: o.session.registrationGeneration ?? '',
        state: o.projection.turn.state,
        turn:
          o.projection.turnId === null || o.projection.turn.status === null
            ? null
            : {
                id: o.projection.turnId,
                status: o.projection.turn.status,
                startedAt: o.projection.turnStartedAt,
              },
      },
      command.generation,
      command.turnId,
    );
  if (!cancellable()) {
    await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'rejected' });
    return;
  }
  await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'uncertain' });
  // Writing yields, and the turn may settle in that gap. Re-checking is what stops this cancelling
  // whatever turn started next.
  if (!cancellable()) {
    await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'rejected' });
    return;
  }
  o.settleAll('cancel');
  try {
    await o.query?.interrupt?.();
  } catch (error) {
    // An interrupt that cannot be delivered is a rejected interrupt, not a dead session. Throwing
    // here would destroy the conversation the contract promises to keep.
    await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'rejected' });
    await o.report(error);
    return;
  }
  o.projection.turn = advanceTurn(o.projection.turn, { step: 'interrupted' });
  await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'accepted' });
  await o.publish();
}

/**
 * Put the session back into the permission mode it was last given.
 *
 * A restart otherwise dropped it silently: the request file still said the mode had been applied while the
 * runtime came up in `default`, and the drop went the dangerous way — from a mode that asks
 * before writing to one that asks less. A session surviving a restart is this project's whole
 * promise, and a setting that decides what a turn may do to a working tree is part of the session.
 */
export async function restoreMode(o: Mailboxes): Promise<void> {
  const request = readRuntimeMode(o.m, o.session);
  if (!shouldRestoreMode(request, o.session.registrationGeneration) || request === null) return;
  try {
    await o.query?.setPermissionMode?.(request.mode);
    o.projection.permissionMode = request.mode;
  } catch (error) {
    // Reported rather than assumed: publishing a mode the runtime refused would be worse than
    // coming up in the default one, because a reader would trust it.
    await o.report(error);
  }
}

/**
 * Move the session to the permission mode a caller asked for.
 *
 * Applied between turns only. Changing it mid-turn would move the boundary under a tool call that
 * was already judged against the old one — the approval a person gave would then be for a
 * different question than the one being answered.
 */
export async function applyMode(o: Mailboxes): Promise<void> {
  const request = readRuntimeMode(o.m, o.session);
  if (request === null || request.phase !== 'queued') return;
  if (request.generation !== o.session.registrationGeneration) return;
  if (o.projection.turn.status === 'inProgress') return;
  try {
    await o.query?.setPermissionMode?.(request.mode);
  } catch (error) {
    await writeRuntimeMode(o.m, o.session, {
      ...request,
      phase: 'failed',
      reason: 'The runtime refused this permission mode',
    });
    await o.report(error);
    return;
  }
  o.projection.permissionMode = request.mode;
  await writeRuntimeMode(o.m, o.session, { ...request, phase: 'complete', reason: null });
  await o.publish();
}

/**
 * Enable, disable or reconnect one server, then publish what it looks like afterwards.
 *
 * Republishing is the point: a request the runtime accepted is not a server that works, and the
 * caller is answered from the refreshed status rather than from the acceptance.
 */
export async function applyMcpRequest(o: Mailboxes): Promise<void> {
  const request = readRuntimeMcpRequest(o.m, o.session);
  if (request === null || request.phase !== 'queued') return;
  if (request.generation !== o.session.registrationGeneration) return;
  try {
    if (request.action === 'reconnect') await o.query?.reconnectMcpServer?.(request.server);
    else await o.query?.toggleMcpServer?.(request.server, request.action === 'enable');
    await refreshMcpServers(o.discovery);
    await o.publish();
    await writeRuntimeMcpRequest(o.m, o.session, { ...request, phase: 'complete' });
  } catch (error) {
    await writeRuntimeMcpRequest(o.m, o.session, {
      ...request,
      phase: 'failed',
      reason: 'The runtime refused this MCP operation',
    });
    await o.report(error);
  }
}

/**
 * Put the files back, when a caller asked and the turn that touched them has ended.
 *
 * Between turns only, for the same reason the mode change is: restoring files under a running
 * turn changes the tree the turn is reasoning about, halfway through.
 */
export async function applyRewind(o: Mailboxes): Promise<void> {
  const request = readRuntimeRewind(o.m, o.session);
  if (request === null || request.phase !== 'queued') return;
  if (request.generation !== o.session.registrationGeneration) return;
  if (o.projection.turn.status === 'inProgress') return;
  try {
    const result = (await o.query?.rewindFiles?.(request.messageId, {
      dryRun: request.dryRun,
    })) as
      | {
          canRewind?: boolean;
          error?: string;
          filesChanged?: string[];
          insertions?: number;
          deletions?: number;
          skippedLinks?: number;
        }
      | undefined;
    if (!result) throw new Error('The runtime returned no rewind result');
    await writeRuntimeRewind(o.m, o.session, {
      ...request,
      phase: 'complete',
      result: RewindResultSchema.parse({
        canRewind: result.canRewind === true,
        error: result.error ?? null,
        filesChanged: (result.filesChanged ?? []).slice(0, 512),
        insertions: result.insertions ?? null,
        deletions: result.deletions ?? null,
        // Absent means "no refusals happened", which is a different fact from "not measured" —
        // and only a real rewind can report it at all, so a preview leaves it null.
        skippedLinks: request.dryRun ? null : (result.skippedLinks ?? 0),
      }),
    });
  } catch (error) {
    await writeRuntimeRewind(o.m, o.session, {
      ...request,
      phase: 'failed',
      reason: 'The runtime could not rewind these files',
    });
    await o.report(error);
  }
}
