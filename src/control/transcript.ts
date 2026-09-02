import { AppError } from 'stitchkit';
import type { z } from 'zod';
import { type TranscriptWindow, transcriptJson } from '../commands/transcript.ts';
import type { MachineConfig } from '../types.ts';
import type { ControlTranscriptReadSchema } from './schema.ts';
import { controlTarget } from './target.ts';

/**
 * One session's transcript window, answered without a process start.
 *
 * A consumer watching eight conversations asked by spawning `ccmux transcript` eight times, and
 * paid a runtime launch for every question. The read itself is now cheap; the launch is what is
 * left, and it is the one cost a resident service removes. Same answer, same cursor, same builder
 * as the command — the window is not a second view of the conversation.
 */
export function readControlTranscript(
  m: MachineConfig,
  input: z.output<typeof ControlTranscriptReadSchema>,
) {
  const session = controlTarget(m, input.target);
  const window: TranscriptWindow = { tail: input.tail };
  if (input.cursor !== null) window.cursor = input.cursor;
  if (input.before !== null) window.before = input.before;
  if (input.limit !== null) window.limit = input.limit;
  if (input.textLimit !== null) window.textLimit = input.textLimit;
  const answer = transcriptJson(m, session, window);
  // A runtime that keeps no transcript on disk is not an error to retry: it is an answer, and it
  // says which runtime it is. Refusing here instead would send a caller looking for a fault.
  if (!answer.source.available && answer.source.error === null)
    throw new AppError('UNSUPPORTED', 'This runtime keeps no transcript file', 409);
  return { ...answer, target: input.target };
}
