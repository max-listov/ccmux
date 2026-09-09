import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { AppError } from 'stitchkit';
import {
  type CommunicationAuthorization,
  type CommunicationAuthorizationInput,
  CommunicationAuthorizationInputSchema,
  CommunicationAuthorizationSchema,
} from './communicationAuthorizationSchema.ts';
import { type LocalMessageLookup, resolveCommunicationBasis } from './communicationBasis.ts';
import type { ChatPrincipal, ChatTarget } from './identitySchema.ts';
import type { MessageOrigin } from './originSchema.ts';

/** The refusal names what would be accepted. A gate that says only "denied" tells the reader to
 *  guess, and guessing at an authorization is the failure this whole object exists to prevent. */
export const COMMUNICATION_BASES = [
  'user-instruction    — the user said it in YOUR conversation; quote it and say where',
  'peer-letter         — a peer letter carried the permission; reference it as <peer thread uuid>#<message uuid>, and ccmux resolves it against this machine’s own records',
  'thread-continuation — this correspondence is already authorized; reference the earlier message and repeat nothing',
];

export const COMMUNICATION_AUTHORIZATION_HELP = `--communication-authorization <JSON file> is required before contacting a session. Legal bases:
  ${COMMUNICATION_BASES.join('\n  ')}
Opening file:
${JSON.stringify(
  {
    basis: 'user-instruction',
    whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope:
      '<40–4000 characters: why this peer and this authorized work>',
    userAuthorizationQuote: '<verbatim user words>',
    sourceMessageRef: '<source user message>',
  },
  null,
  2,
)}
For peer-letter use the same rationale, a verbatim quote from that letter and sourceMessageRef "<peer thread uuid>#<message uuid>".
Continuation file (reuse for the same pair and --task):
${JSON.stringify({ basis: 'thread-continuation', sourceMessageRef: '<peer thread uuid>#<your accepted message uuid>' }, null, 2)}
These are unverified consent claims, not credentials or permission to transfer files.`;

export function requireCommunicationAuthorization(
  from: ChatPrincipal,
  origin: MessageOrigin,
  evidence: CommunicationAuthorization | null | undefined,
): void {
  if (evidence != null) {
    CommunicationAuthorizationSchema.parse(evidence);
    if (evidence.basis === undefined)
      throw new AppError(
        'COMMUNICATION_AUTHORIZATION_UNVERIFIED',
        `communicationAuthorization must name its basis. ${COMMUNICATION_AUTHORIZATION_HELP}`,
        403,
      );
    return;
  }
  // Only the application's admitted human channel can omit agent justification. A CLI or
  // managed runtime cannot promote itself by supplying an actor label.
  if (
    from.kind === 'service' &&
    origin.actor === 'human' &&
    origin.assurance === 'application-attested' &&
    origin.application !== null
  )
    return;
  throw new AppError(
    'COMMUNICATION_AUTHORIZATION_REQUIRED',
    `communicationAuthorization is required. ${COMMUNICATION_AUTHORIZATION_HELP}`,
    403,
  );
}

/** References are resolved on the originating host, never guessed from another host's absence. */
export function requireOriginatingBasis(
  from: ChatPrincipal,
  to: ChatTarget,
  evidence: CommunicationAuthorization | null | undefined,
  lookup: LocalMessageLookup | null,
  task: string | null = null,
) {
  if (evidence == null) return undefined;
  if (evidence.basis === undefined)
    throw new AppError(
      'COMMUNICATION_AUTHORIZATION_UNVERIFIED',
      `communicationAuthorization must name its basis. ${COMMUNICATION_AUTHORIZATION_HELP}`,
      403,
    );
  if (lookup === null) {
    if (evidence.basis !== 'user-instruction')
      throw new AppError(
        'COMMUNICATION_AUTHORIZATION_UNVERIFIED',
        'Referenced authorization must be resolved on the originating host before transport',
        403,
      );
    return { authorization: evidence, sourceLetter: null };
  }
  return resolveCommunicationBasis(from, to, task, evidence, lookup);
}

/** File input keeps private quotes out of process arguments; reads have a fixed byte budget. */
export async function readCommunicationAuthorization(
  path: string,
): Promise<CommunicationAuthorizationInput> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular JSON file');
    const limit = 64 * 1024;
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('Communication authorization file exceeds 64 KiB');
    return CommunicationAuthorizationInputSchema.parse(
      JSON.parse(bytes.subarray(0, length).toString('utf8')),
    );
  } finally {
    await file.close();
  }
}
