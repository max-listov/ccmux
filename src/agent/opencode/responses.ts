import type { MachineConfig, Session } from '../../types.ts';
import {
  clearNativeCommand,
  readNativeCommand,
  readNativeReceipt,
  writeNativeReceipt,
} from '../codex/ownedControl.ts';
import type { OpenCodeProjection } from './projection.ts';
import type { OpenCodeClient } from './server.ts';

export async function applyOpenCodeResponse(
  m: MachineConfig,
  session: Session,
  client: OpenCodeClient,
  projection: OpenCodeProjection,
  signal: AbortSignal,
): Promise<void> {
  const command = readNativeCommand(m, session.name);
  if (!command) return;
  const prior = readNativeReceipt(m, session.name);
  if (prior?.operationId === command.operationId) {
    clearNativeCommand(m, session.name);
    return;
  }
  const snapshot = projection.snapshot();
  const request = snapshot.pendingRequests.find((value) => value.requestId === command.requestId);
  const receipt = async (
    outcome: 'submitted' | 'rejected' | 'uncertain',
    reason: string | null,
  ) => {
    await writeNativeReceipt(m, session.name, {
      operationId: command.operationId,
      requestId: command.requestId,
      fingerprint: command.fingerprint,
      outcome,
      reason,
    });
  };
  const reject = async (reason: string) => {
    await receipt('rejected', reason);
    clearNativeCommand(m, session.name);
  };
  if (
    command.generation !== snapshot.generation ||
    request === undefined ||
    request.kind !== command.kind
  )
    return reject('request-identity-mismatch');
  if (
    command.kind === 'approval' &&
    (command.decision === null || !request.decisions.includes(command.decision))
  )
    return reject('decision-is-not-available');
  if (command.kind === 'input') {
    if (
      command.answers === null ||
      JSON.stringify(Object.keys(command.answers).sort()) !==
        JSON.stringify(request.questions.map((q) => q.id).sort())
    )
      return reject('question-id-mismatch');
    for (const question of request.questions) {
      const answers = command.answers[question.id];
      if (
        !answers ||
        (!question.multiple && answers.length !== 1) ||
        (!question.isOther &&
          answers.some((answer) => !question.options?.some((option) => option.label === answer)))
      )
        return reject('answer-is-not-available');
    }
  }
  // A response has side effects too. A lost native ACK remains uncertain, not an automatic replay.
  await receipt('uncertain', null);
  if (command.kind === 'approval') {
    const reply =
      command.decision === 'accept'
        ? 'once'
        : command.decision === 'acceptForSession'
          ? 'always'
          : 'reject';
    await client.permission.reply({ requestID: command.requestId, reply }, { signal });
  } else {
    const answers = command.answers;
    if (answers === null) throw new Error('Validated answers disappeared');
    await client.question.reply(
      {
        requestID: command.requestId,
        answers: request.questions.map((question) => answers[question.id] ?? []),
      },
      { signal },
    );
  }
  projection.resolve(command.requestId);
  await receipt('submitted', null);
  clearNativeCommand(m, session.name);
}
