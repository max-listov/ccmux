import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { AppError } from 'stitchkit';
import {
  type CommunicationAuthorization,
  CommunicationAuthorizationSchema,
} from './communicationAuthorizationSchema.ts';
import type { ChatPrincipal } from './identitySchema.ts';
import type { MessageOrigin } from './originSchema.ts';

export function requireCommunicationAuthorization(
  from: ChatPrincipal,
  origin: MessageOrigin,
  evidence: CommunicationAuthorization | null | undefined,
): void {
  if (evidence != null) {
    CommunicationAuthorizationSchema.parse(evidence);
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
    'communicationAuthorization is required: explain the recipient and scope, quote the user authorization, and reference its source message',
    403,
  );
}

/** File input keeps private quotes out of process arguments; reads have a fixed byte budget. */
export async function readCommunicationAuthorization(
  path: string,
): Promise<CommunicationAuthorization> {
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
    return CommunicationAuthorizationSchema.parse(
      JSON.parse(bytes.subarray(0, length).toString('utf8')),
    );
  } finally {
    await file.close();
  }
}
