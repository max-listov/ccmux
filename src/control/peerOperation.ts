import { ApiError, AppError } from 'stitchkit';
import { z } from 'zod';
import type { ChatPrincipal } from '../chat/identitySchema.ts';
import type { Route } from '../fleet/address.ts';
import { type RemoteResult, runPeer } from '../fleet/transport.ts';
import type { MachineConfig } from '../types.ts';
import { controlContract } from './schema/contract.ts';

/**
 * A control operation whose target is a session on another machine, answered by that machine's
 * daemon.
 *
 * The daemon that is asked does not act on another machine's session itself, and it does not
 * refuse either: it hands the same call — the operation's name and its validated input — to the
 * target machine, which runs `ccmux _peer-operation <name>` with the input on stdin. That program
 * asks its own daemon over the local socket and prints one line, the answer or the refusal, which
 * comes back here as this operation's answer. The transport is the one every fleet read uses
 * (`fleet/transport.ts`): the remote route where it is configured, ssh where it is not.
 *
 * Authority is decided where the session is. The far daemon sees the call as its own machine's
 * command line, exactly as `ccmux stop <machine>:<name>` has always arrived there, so a delegated
 * session refuses it unless that machine's own rules let its command line act. One caller is not
 * forwarded at all: a caller authenticated by this machine's declared service. Its reach is the
 * machine whose service authenticated it; forwarded, it would act on another machine with that
 * machine's command-line authority, which no service on that machine granted.
 */
export const FORWARDED_OPERATIONS = [
  'session.start',
  'session.stop',
  'session.restart',
  'session.remove',
  'session.keys',
  'message.read',
] as const satisfies readonly (keyof typeof controlContract.endpoints)[];
export type ForwardedOperation = (typeof FORWARDED_OPERATIONS)[number];

type Endpoints = typeof controlContract.endpoints;
export type ForwardedInput<K extends ForwardedOperation> = z.output<Endpoints[K]['input']>;
export type ForwardedOutput<K extends ForwardedOperation> = z.output<Endpoints[K]['output']>;

export const isForwardedOperation = (key: string): key is ForwardedOperation =>
  (FORWARDED_OPERATIONS as readonly string[]).includes(key);

/** The one line `_peer-operation` prints: the operation's answer, or the refusal it met. */
export const PeerOperationAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.string().min(1).max(64),
      status: z.int().min(400).max(599),
      message: z.string().max(4096),
    })
    .strict(),
]);
export type PeerOperationAnswer = z.infer<typeof PeerOperationAnswerSchema>;

/**
 * How long the target machine has for the call: the hop and the operation together. Every public
 * operation answers within 30 s, the service transport's budget; this leaves the hand-over room to
 * say why the far side did not answer instead of being cut at that budget.
 */
export const PEER_OPERATION_TIMEOUT_MS = 25_000;

/** Only a caller local to this machine is forwarded; see the module comment. */
export function forwardable(principal: ChatPrincipal): boolean {
  return !(principal.kind === 'service' && principal.transport === 'declared-service');
}

const refusal = (code: string, status: number, message: string) =>
  new AppError(code, { message, status });

/**
 * Hands one call to the target machine and returns its answer as this operation's own: parsed by
 * the operation's output schema, or thrown as the refusal the far daemon gave, under its code.
 */
export async function forwardOperation<K extends ForwardedOperation>(
  m: MachineConfig,
  route: Extract<Route, { kind: 'remote' }>,
  key: K,
  input: ForwardedInput<K>,
  principal: ChatPrincipal,
  signal?: AbortSignal,
  run: typeof runPeer = runPeer,
): Promise<ForwardedOutput<K>> {
  if (!forwardable(principal))
    throw refusal(
      'FORBIDDEN',
      403,
      `A caller of this machine's service reaches ${route.machine} through that machine's own service`,
    );
  const result = await run(m, route.machine, route.alias, ['ccmux', '_peer-operation', key], {
    stdin: JSON.stringify(input),
    timeoutMs: PEER_OPERATION_TIMEOUT_MS,
    signal,
  });
  const answer = readAnswer(result);
  if (answer === null) throw unanswered(route.machine, key, result);
  if (!answer.ok) throw refusal(answer.code, answer.status, answer.message);
  return controlContract.endpoints[key].output.parse(answer.result) as ForwardedOutput<K>;
}

function readAnswer(result: RemoteResult): PeerOperationAnswer | null {
  if (result.transportFailed) return null;
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  try {
    const parsed = PeerOperationAnswerSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The far side did not answer the call: the hop failed, or what answered is not a program that
 * takes forwarded operations. Each is its own sentence, because each sends the reader somewhere
 * else — a network, a release, a policy.
 */
function unanswered(machine: string, key: string, result: RemoteResult): AppError {
  if (result.transportFailed) {
    const cause = result.failureDetail ?? 'not reachable right now';
    const certainty =
      result.delivery === 'not-sent'
        ? 'nothing was sent'
        : result.delivery === 'unknown'
          ? 'whether it ran there is unknown; read the session before repeating it'
          : 'the call reached it';
    if (result.permanent)
      return refusal('FORBIDDEN', 403, `${machine} refuses ${key}: ${cause}; ${certainty}`);
    return refusal('UNAVAILABLE', 503, `${machine} did not answer ${key}: ${cause}; ${certainty}`);
  }
  // A release older than forwarding answers an unknown verb with its help text and exit 1.
  return refusal(
    'UNKNOWN_OPERATION',
    501,
    `${machine} does not take a forwarded ${key}: its ccmux answered with exit ${result.code} and no operation answer; update it`,
  );
}

/**
 * The target machine's side: one call read from stdin, asked of this machine's daemon, answered
 * as one line. A refusal is an answer, not a failure of this program, so it exits 0 either way.
 */
export async function answerPeerOperation(
  key: string,
  raw: string,
  call: (key: ForwardedOperation, input: unknown) => Promise<unknown>,
): Promise<PeerOperationAnswer> {
  if (!isForwardedOperation(key))
    return {
      ok: false,
      code: 'UNKNOWN_OPERATION',
      status: 501,
      message: `${key} is not an operation this machine takes from another`,
    };
  let input: unknown;
  try {
    input = controlContract.endpoints[key].input.parse(JSON.parse(raw));
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      status: 400,
      message: `${key}: ${error instanceof Error ? error.message.slice(0, 1024) : String(error)}`,
    };
  }
  try {
    return { ok: true, result: await call(key, input) };
  } catch (error) {
    if (error instanceof ApiError || error instanceof AppError)
      return {
        ok: false,
        code: error.code,
        // Status 0: the call never reached this machine's daemon — it is not running.
        status: error.status >= 400 && error.status <= 599 ? error.status : 503,
        message: error.message.slice(0, 4096),
      };
    throw error;
  }
}
