import { AppError } from 'stitchkit';
import { createOperationProcesses } from 'stitchkit/process';
import type { z } from 'zod';
import type { LetterRequest } from '../../chat/letterRequestSchema.ts';
import { followLog, type LogFrame, parseCursor, ZERO_CURSOR } from '../../chat/logFeed.ts';
import { sendLetter } from '../../chat/sendLetter.ts';
import { sentLetters } from '../../chat/sentLetters.ts';
import { readExactMessage } from '../../context/exactMessage.ts';
import { SearchRequestError, searchPlan } from '../../context/searchFleet.ts';
import { SEARCH_FRAME_MAX_BYTES } from '../../context/searchFrames.ts';
import { SearchRequestSchema } from '../../context/searchRequestSchema.ts';
import { SearchPatternError } from '../../context/transcriptSearch.ts';
import { routeFor } from '../../fleet/address.ts';
import { chatLogAnswer } from '../../fleet/chatLog.ts';
import { fleetAnswer } from '../../fleet/fleetList.ts';
import type { WhoisEvent } from '../../session/identitySchema.ts';
import { findSession, loadSessions } from '../../session/registry.ts';
import { followIdentities, whoisAll, whoisFleet } from '../../session/whoisFleet.ts';
import type { ChatPrincipal } from '../../types.ts';
import { SELF_ARGV } from '../../util/env.ts';
import { followed } from '../../util/followed.ts';
import type {
  ChatFollowReadSchema,
  ChatLogReadSchema,
  ExactMessageReadSchema,
  IdentityListReadSchema,
  IdentityWhoisReadSchema,
  SentLettersReadSchema,
} from '../schema/reading.ts';
import { searchContract } from '../schema/searchContract.ts';
import type { OperationContext } from './context.ts';
import { controlRefusal } from './refusal.ts';

/** A fleet question waits on other machines; its budget is theirs, not a local read's — and it
 *  ends inside the longest wait the service transport carries. */
const FLEET_READ_MS = 29_000;
/** Searches reading at once. Each is a process, and each of those deals out more. */
const SEARCHES_AT_ONCE = 2;
/** The longest a search may run; a fleet machine is given three minutes of it. */
const SEARCH_MS = 200_000;
/**
 * How long a letter to another machine may take to name its recipient there and hand it over: the
 * hops share it, inside the 30 s every public operation answers within.
 */
const LETTER_SEND_MS = 27_000;
/** Changes a follower may fall behind by before it is told to read again from the start. */
const FOLLOW_BACKLOG = 4096;

/**
 * Who a session is, what was said, who sent it and what was sent — the reads a program asks by name
 * instead of running the command and reading what it printed. Each answers with the object the
 * command prints under `--json`, built by the same function.
 */
export function readingOperations(context: OperationContext) {
  const { m, reads } = context;
  const searchInProcess = createOperationProcesses({
    command: {
      executable: SELF_ARGV[0] as string,
      args: [...SELF_ARGV.slice(1), '_operation'],
      envPolicy: 'ambient',
    },
    maxConcurrent: SEARCHES_AT_ONCE,
    maxResponseBytes: SEARCH_FRAME_MAX_BYTES,
    timeoutMs: SEARCH_MS,
  }).stream(searchContract, 'search');
  const fleetRead = <T>(run: () => Promise<T>, signal?: AbortSignal) =>
    reads
      .run(undefined, run, { ...(signal ? { signal } : {}), timeoutMs: FLEET_READ_MS })
      .catch(controlRefusal);
  return {
    whois: (input: z.output<typeof IdentityWhoisReadSchema>, signal?: AbortSignal) =>
      fleetRead(() => whoisFleet(m, input.query, { local: input.local }), signal),
    identities: (input: z.output<typeof IdentityListReadSchema>, signal?: AbortSignal) =>
      fleetRead(() => whoisAll(m, { local: input.local }), signal),
    chatLog: (input: z.output<typeof ChatLogReadSchema>, signal?: AbortSignal) =>
      fleetRead(() => chatLogAnswer(m, input), signal),
    fleet: (signal?: AbortSignal) => fleetRead(() => fleetAnswer(m), signal),
    /** Every session's identity, then each change — the stream `ccmux whois --follow` prints. */
    followIdentities: (
      input: z.output<typeof IdentityListReadSchema>,
      signal: AbortSignal,
    ): AsyncIterable<WhoisEvent> =>
      followed<WhoisEvent>(signal, (emit) => followIdentities(m, emit, { local: input.local }), {
        backlog: FOLLOW_BACKLOG,
        // A reader this far behind would be told changes out of an order it can trust.
        lagged: () =>
          new AppError('LAGGED', {
            message: 'The identity stream fell behind its reader; follow again',
            status: 409,
          }),
      }),
    /**
     * This machine's chat log from a cursor, then every row as it is written: the frames
     * `ccmux chat log --follow` prints, from the same producer (`followLog`).
     */
    followChatLog: (
      input: z.output<typeof ChatFollowReadSchema>,
      signal: AbortSignal,
    ): AsyncIterable<LogFrame> => {
      const from = input.since === null ? ZERO_CURSOR : parseCursor(input.since);
      if ('error' in from)
        throw new AppError('INVALID_INPUT', {
          message: `since needs a cursor this log gave: ${from.error}`,
          status: 400,
        });
      const cursor = 'cursor' in from ? from.cursor : from;
      return followed<LogFrame>(signal, (emit) => followLog(m, cursor, emit), {
        backlog: FOLLOW_BACKLOG,
        lagged: () =>
          new AppError('LAGGED', {
            message:
              'The chat log stream fell behind its reader; follow again from its last cursor',
            status: 409,
          }),
      });
    },
    /**
     * One search of every stored conversation, in frames; `collectSearch` makes the object of it.
     *
     * Not answered in this loop: the daemon answers every session's status from it, and a read of
     * gigabytes inside it is every other caller waiting. The call is a process of its own, ended
     * when the caller leaves; a third search at once is refused, not queued behind two that may run
     * for minutes.
     */
    search: (call: Parameters<typeof searchInProcess>[0]) => {
      try {
        // Said before a process is started: a request that names no search is the caller's.
        searchPlan(SearchRequestSchema.parse(call.input));
      } catch (error) {
        if (error instanceof SearchPatternError || error instanceof SearchRequestError)
          throw new AppError('VALIDATION_ERROR', { message: error.message, status: 400 });
        throw error;
      }
      return searchInProcess(call);
    },
    exactMessage: (input: z.output<typeof ExactMessageReadSchema>, signal?: AbortSignal) =>
      reads
        .run(
          undefined,
          async () => {
            const route = routeFor(input.address, m);
            const session =
              route.kind === 'local' ? findSession(loadSessions(m), route.session) : undefined;
            if (session === undefined)
              throw new AppError('INVALID_TARGET', {
                message: 'A message is read by the exact address of a session on this machine',
                status: 400,
              });
            return readExactMessage(m, session, input.messageId);
          },
          { ...(signal ? { signal } : {}), timeoutMs: 6_000 },
        )
        .catch(controlRefusal),
    /** What the CALLER sent: a letter's state and the reference a continuation cites. */
    sentLetters: (input: z.output<typeof SentLettersReadSchema>, caller: ChatPrincipal) =>
      sentLetters(m, caller, input.task ?? undefined),
    /**
     * A letter from the caller, as `ccmux msg --json` sends it and with its receipt: the same
     * function. A letter that cannot be sent as asked is refused with the sentence the command says.
     */
    sendLetter: async (input: LetterRequest, caller: ChatPrincipal) => {
      const outcome = await sendLetter(m, caller, input, {
        deadline: Date.now() + LETTER_SEND_MS,
      });
      if (outcome.status === 'refused')
        throw new AppError('LETTER_REFUSED', { message: outcome.reason, status: 409 });
      return outcome.receipt;
    },
  };
}
