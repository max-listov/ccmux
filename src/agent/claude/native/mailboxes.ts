import type { AgentEngineTurn } from 'stitchkit/agent-executor';
import type { ClaudeSdkSession } from 'stitchkit/agent-executor/claude-sdk';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../../runtime/interrupt.ts';
import { readRuntimeMcpRequest, writeRuntimeMcpRequest } from '../../../runtime/mcpControl.ts';
import { type PermissionMode, PermissionModeSchema } from '../../../runtime/projectionSchema.ts';
import { answerNativeCommand } from '../../../runtime/response.ts';
import { readRuntimeRewind, writeRuntimeRewind } from '../../../runtime/rewind.ts';
import { RewindResultSchema } from '../../../runtime/rewindSchema.ts';
import {
  readRuntimeMode,
  shouldRestoreMode,
  writeRuntimeMode,
} from '../../../runtime/sessionMode.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { type Discovery, refreshMcpServers } from './discovery.ts';
import { type PendingApproval, toInteractionReply } from './permission.ts';
import type { NativeProjection } from './projection.ts';
import { advanceTurn } from './turn.ts';

/**
 * Everything a caller can ask a live native Claude session to DO, other than take a turn.
 */
export interface Mailboxes {
  m: MachineConfig;
  session: Session;
  sdkSession: ClaudeSdkSession | null;
  activeTurn: () => AgentEngineTurn | null;
  projection: NativeProjection;
  discovery: Discovery;
  pending: Map<string, PendingApproval>;
  publish: () => Promise<void>;
  report: (error: unknown) => Promise<void>;
}

/** Apply one decision the control plane wrote, and acknowledge it. */
export async function applyResponse(o: Mailboxes): Promise<void> {
  await answerNativeCommand(o.m, o.session.name, {
    generation: o.session.registrationGeneration,
    pending: (requestId) => o.pending.get(requestId)?.request ?? null,
    submit: async (command) => {
      const waiting = o.pending.get(command.requestId);
      const turn = o.activeTurn();
      if (waiting === undefined || turn === null || command.decision === null)
        throw new Error('Validated approval disappeared');
      await turn.respond(
        command.requestId,
        toInteractionReply(command.decision, { toolName: waiting.toolName }),
      );
      o.pending.delete(command.requestId);
      o.projection.turn = advanceTurn(o.projection.turn, { step: 'answered' });
      o.projection.content?.buffer.lifecycle(
        'request',
        waiting.request.turnId,
        command.requestId,
        command.decision,
      );
      o.projection.content?.publish();
      await o.publish();
    },
  });
}

/** Cancel the running turn through `AgentEngineTurn.interrupt()`. */
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
  const turn = o.activeTurn();
  if (!cancellable() || turn === null) {
    await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'rejected' });
    return;
  }
  await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'uncertain' });
  if (!cancellable() || o.activeTurn() === null) {
    await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'rejected' });
    return;
  }
  try {
    await turn.interrupt();
  } catch (error) {
    await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'rejected' });
    await o.report(error);
    return;
  }
  o.pending.clear();
  o.projection.turn = advanceTurn(o.projection.turn, { step: 'interrupted' });
  await writeRuntimeInterrupt(o.m, o.session, { ...command, phase: 'accepted' });
  await o.publish();
}

async function setRuntimeMode(o: Mailboxes, requested: PermissionMode): Promise<void> {
  if (o.sdkSession === null) throw new Error('Claude permission control is unavailable');
  const response = await o.sdkSession.setPermissionMode(requested);
  // The SDK permits a successful command to acknowledge the requested mode with no payload.
  const applied = response?.mode ?? requested;
  const effective = PermissionModeSchema.safeParse(applied);
  o.projection.permissionMode = effective.success ? effective.data : undefined;
  if (applied !== requested) throw new Error(`Claude applied ${applied} instead of ${requested}`);
}

export async function restoreMode(o: Mailboxes): Promise<void> {
  const request = readRuntimeMode(o.m, o.session);
  if (!shouldRestoreMode(request, o.session.registrationGeneration) || request === null) return;
  try {
    await setRuntimeMode(o, request.mode);
  } catch (error) {
    await o.report(error);
  }
}

export async function applyMode(o: Mailboxes): Promise<void> {
  const request = readRuntimeMode(o.m, o.session);
  if (request === null || request.phase !== 'queued') return;
  if (request.generation !== o.session.registrationGeneration) return;
  if (o.projection.turn.status === 'inProgress') return;
  try {
    await setRuntimeMode(o, request.mode);
  } catch (error) {
    await writeRuntimeMode(o.m, o.session, {
      ...request,
      phase: 'failed',
      reason: 'The runtime did not confirm the requested permission mode',
    });
    await o.publish();
    await o.report(error);
    return;
  }
  await writeRuntimeMode(o.m, o.session, { ...request, phase: 'complete', reason: null });
  await o.publish();
}

export async function applyMcpRequest(o: Mailboxes): Promise<void> {
  const request = readRuntimeMcpRequest(o.m, o.session);
  if (request === null || request.phase !== 'queued') return;
  if (request.generation !== o.session.registrationGeneration) return;
  try {
    if (request.action === 'reconnect') await o.sdkSession?.reconnectMcpServer(request.server);
    else await o.sdkSession?.toggleMcpServer(request.server, request.action === 'enable');
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

export async function applyRewind(o: Mailboxes): Promise<void> {
  const request = readRuntimeRewind(o.m, o.session);
  if (request === null || request.phase !== 'queued') return;
  if (request.generation !== o.session.registrationGeneration) return;
  if (o.projection.turn.status === 'inProgress') return;
  try {
    const result = await o.sdkSession?.rewindFiles(request.messageId, {
      dryRun: request.dryRun,
    });
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
