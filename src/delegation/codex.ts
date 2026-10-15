import { z } from 'zod';
import type { Session } from '../types.ts';
import { delegationRefused, verifyDelegatedSession } from './resolve.ts';

export function delegatedCodexPolicy(session: Session) {
  if (session.delegation === undefined) return {};
  verifyDelegatedSession(session);
  const access = session.delegation.policy.access;
  if (access === 'full-access') delegationRefused('Unconfined delegation is unsupported');
  return {
    approvalPolicy: 'never',
    sandboxPolicy:
      access === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : {
            type: 'workspaceWrite',
            writableRoots: [session.dir],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
  };
}
export function assertDelegatedCodexAcknowledgement(session: Session, response: unknown): void {
  if (session.delegation === undefined) return;
  const value = z
    .object({
      approvalPolicy: z.literal('never'),
      sandbox: z.object({
        type: z.enum(['readOnly', 'workspaceWrite']),
        networkAccess: z.literal(false).optional(),
        writableRoots: z.array(z.string()).optional(),
        excludeTmpdirEnvVar: z.boolean().optional(),
        excludeSlashTmp: z.boolean().optional(),
      }),
    })
    .safeParse(response);
  if (!value.success) delegationRefused('Provider did not acknowledge delegated policy');
  const expected = delegatedCodexPolicy(session).sandboxPolicy;
  if (
    value.data.sandbox.type !== expected?.type ||
    (expected?.type === 'workspaceWrite' &&
      (JSON.stringify(value.data.sandbox.writableRoots) !== JSON.stringify([session.dir]) ||
        value.data.sandbox.excludeTmpdirEnvVar !== true ||
        value.data.sandbox.excludeSlashTmp !== true))
  )
    delegationRefused('Provider changed delegated policy');
}
