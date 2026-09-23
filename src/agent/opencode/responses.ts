import { answerNativeCommand } from '../../runtime/response.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { OpenCodeProjection } from './projection.ts';
import type { OpenCodeClient } from './server.ts';

export async function applyOpenCodeResponse(
  m: MachineConfig,
  session: Session,
  client: OpenCodeClient,
  projection: OpenCodeProjection,
  signal: AbortSignal,
): Promise<void> {
  const snapshot = projection.snapshot();
  await answerNativeCommand(m, session.name, {
    generation: snapshot.generation,
    pending: (requestId) =>
      snapshot.pendingRequests.find((value) => value.requestId === requestId) ?? null,
    submit: async (command, request) => {
      if (command.kind === 'approval') {
        const reply =
          command.decision === 'accept'
            ? 'once'
            : command.decision === 'acceptForSession'
              ? 'always'
              : 'reject';
        await client.permission.reply({ requestID: command.requestId, reply }, { signal });
      } else {
        const answers = command.answers ?? {};
        await client.question.reply(
          {
            requestID: command.requestId,
            answers: request.questions.map((question) => answers[question.id] ?? []),
          },
          { signal },
        );
      }
      projection.resolve(command.requestId);
    },
  });
}
