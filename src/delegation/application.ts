import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { writePrivateJson } from '../attachments/files.ts';
import { sameTarget } from '../chat/identity.ts';
import type { ManagedPeerSchema } from '../chat/identitySchema.ts';
import { admitMessageOrigin } from '../chat/origin.ts';
import { controlTarget } from '../control/target.ts';
import { privateRuntimeDirectory, readPrivateJournal } from '../runtime/store.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { withLock } from '../util/lock.ts';
import {
  ApplicationAuthorityCapabilitiesSchema,
  ApplicationAuthorityOpenSchema,
  ApplicationAuthoritySchema,
  type ApplicationAuthoritySelectorSchema,
  type ApplicationAuthorityUpdateSchema,
} from './applicationSchema.ts';
import { delegationRefused } from './resolve.ts';

type Authority = z.infer<typeof ApplicationAuthoritySchema>;
const OperationSchema = z
  .object({
    id: z.uuid(),
    fingerprint: z.string(),
    result: ApplicationAuthoritySchema.pick({
      expiresAt: true,
      closedAt: true,
      lastOperationId: true,
    }),
  })
  .strict();
const RecordSchema = ApplicationAuthoritySchema.extend({
  operations: z.array(OperationSchema).max(4097),
});
type Record = z.infer<typeof RecordSchema>;
const receipt = (row: Record): Authority => {
  const { operations: _, ...value } = row;
  return value;
};
const fingerprint = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex');
type Parent = z.infer<typeof ApplicationAuthoritySelectorSchema>['parent'];
const root = (m: MachineConfig) => join(m.stateDir, 'control', 'application-authorities');
const file = (id: string) => `${ApplicationAuthorityOpenSchema.shape.operationId.parse(id)}.json`;
function read(m: MachineConfig, id: string) {
  return readPrivateJournal(join(root(m), file(id)), RecordSchema, 2 * 1024 * 1024);
}
function binding(m: MachineConfig, principal: ChatPrincipal, input: Authority['binding']) {
  const origin = admitMessageOrigin(m, principal, input, 'conversation');
  const grant = m.applicationDelegationAuthorities?.find(
    (row) => stableJson(row.binding) === stableJson(input),
  );
  if (origin.application?.revision !== input.revision || grant === undefined)
    delegationRefused('Application authority binding is unavailable');
  if (realpathSync(grant.policy.workspace) !== grant.policy.workspace)
    delegationRefused('Application authority workspace must be canonical');
  return { grant, digest: origin.application.digest };
}
export function applicationAuthorityCapabilities(m: MachineConfig, principal: ChatPrincipal) {
  const bindings = (m.applicationDelegationAuthorities ?? []).filter((grant) => {
    try {
      binding(m, principal, grant.binding);
      return true;
    } catch {
      return false;
    }
  });
  return ApplicationAuthorityCapabilitiesSchema.parse({
    bindings,
    assurance: 'application-attested',
    requiresTrustedRunAttestation: true,
  });
}
function issuer(m: MachineConfig, principal: ChatPrincipal, row: Authority) {
  const current = binding(m, principal, row.binding);
  if (
    principal.kind !== 'service' ||
    principal.machine !== row.caller ||
    current.digest !== row.bindingDigest ||
    stableJson(current.grant.policy) !== stableJson(row.policy)
  )
    delegationRefused('Application authority issuer changed');
  return current.grant;
}
function exact(m: MachineConfig, parent: Parent): Record {
  const row = read(m, parent.target.authorityId);
  if (
    row === null ||
    stableJson(row.parent) !== stableJson(parent) ||
    parent.target.machine !== m.rcPrefix
  )
    delegationRefused('Application parent authority is unavailable');
  return row;
}
function active(row: Authority): void {
  if (
    row.closedAt !== null ||
    Date.now() >= Date.parse(row.expiresAt) ||
    Date.now() >= Date.parse(row.deadlineAt)
  )
    delegationRefused('Application parent authority has ended');
}
/** Service callers attest runs at their authenticated gateway, never in model tool arguments. */
export async function openApplicationAuthority(
  m: MachineConfig,
  principal: ChatPrincipal,
  raw: z.infer<typeof ApplicationAuthorityOpenSchema>,
) {
  const input = ApplicationAuthorityOpenSchema.parse(raw);
  const { grant, digest } = binding(m, principal, input.binding);
  if (principal.kind !== 'service') delegationRefused('Application issuer must be a service');
  privateRuntimeDirectory(root(m));
  return withLock(
    join(root(m), `${file(input.operationId)}.lock`),
    async () => {
      const prior = read(m, input.operationId);
      if (prior !== null) {
        issuer(m, principal, prior);
        const original = ApplicationAuthorityOpenSchema.parse(
          Object.fromEntries(
            Object.keys(ApplicationAuthorityOpenSchema.shape).map((key) => [
              key,
              prior[key as keyof Authority],
            ]),
          ),
        );
        if (stableJson(original) !== stableJson(input))
          delegationRefused('Application authority operation conflicts');
        // Never resurrect an expired run by replaying its open operation.
        active(prior);
        return receipt(prior);
      }
      const now = Date.now();
      const row = RecordSchema.parse({
        operations: [],
        ...input,
        parent: {
          target: {
            kind: 'application',
            machine: m.rcPrefix,
            applicationId: input.binding.applicationId,
            authorityId: input.operationId,
          },
          registrationGeneration: crypto.randomUUID(),
        },
        caller: principal.machine,
        assurance: 'application-attested',
        bindingDigest: digest,
        policy: grant.policy,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + Math.min(grant.leaseMs, grant.lifetimeMs)).toISOString(),
        deadlineAt: new Date(now + grant.lifetimeMs).toISOString(),
        closedAt: null,
        lastOperationId: input.operationId,
      });
      writePrivateJson(root(m), file(input.operationId), row);
      return receipt(row);
    },
    'application-authority',
    5_000,
  );
}
export async function updateApplicationAuthority(
  m: MachineConfig,
  principal: ChatPrincipal,
  input: z.infer<typeof ApplicationAuthorityUpdateSchema>,
  close: boolean,
) {
  privateRuntimeDirectory(root(m));
  return withLock(
    join(root(m), `${file(input.parent.target.authorityId)}.lock`),
    async () => {
      const row = exact(m, input.parent),
        grant = issuer(m, principal, row);
      const digest = fingerprint({ input, close });
      if (input.operationId === row.operationId)
        delegationRefused('Application authority operation conflicts with open');
      const prior = row.operations.find((operation) => operation.id === input.operationId);
      if (prior !== undefined) {
        if (prior.fingerprint !== digest)
          delegationRefused('Application authority operation conflicts');
        return { ...receipt(row), ...prior.result };
      }
      if (row.operations.length >= 4097)
        delegationRefused('Application authority operation capacity reached');
      if (close) {
        // Revocation is monotonic; a retry cannot make the authority live again.
        row.closedAt ??= new Date().toISOString();
      } else {
        active(row);
        if (row.operations.length >= 4096)
          delegationRefused('Application authority operation capacity reached');
        if (input.expectedExpiresAt !== row.expiresAt)
          delegationRefused('Application authority renewal revision is stale');
        row.expiresAt = new Date(
          Math.min(Date.now() + grant.leaseMs, Date.parse(row.deadlineAt)),
        ).toISOString();
      }
      row.lastOperationId = input.operationId;
      row.operations.push({
        id: input.operationId,
        fingerprint: digest,
        result: {
          expiresAt: row.expiresAt,
          closedAt: row.closedAt,
          lastOperationId: row.lastOperationId,
        },
      });
      writePrivateJson(root(m), file(row.parent.target.authorityId), row);
      return receipt(row);
    },
    'application-authority',
    5_000,
  );
}
export function requireApplicationAuthority(
  m: MachineConfig,
  principal: ChatPrincipal | undefined,
  parent: Parent,
  allowEnded = false,
) {
  const row = exact(m, parent);
  if (principal === undefined) delegationRefused('Application issuer is required');
  issuer(m, principal, row);
  if (!allowEnded) active(row);
  return row;
}
/** Every launch, input, wake and resident owner loop checks this durable lease. */
export function applicationAuthorityEnded(m: MachineConfig, parent: Parent) {
  try {
    const row = read(m, parent.target.authorityId);
    if (row === null || stableJson(row.parent) !== stableJson(parent)) return true;
    issuer(m, { kind: 'service', source: 'ccmux', machine: row.caller, transport: 'local' }, row);
    active(row);
    return false;
  } catch {
    return true;
  }
}

/** Pin the issuer's human reference and quote when accepting application-origin child input. */
export function requireApplicationInput(
  m: MachineConfig,
  principal: ChatPrincipal,
  parent: Parent,
  origin: { applicationId: string; channelId: string; actor: string } | undefined,
  authorization:
    | {
        basis?: string | undefined;
        sourceMessageRef: string;
        userAuthorizationQuote?: string | undefined;
      }
    | null
    | undefined,
) {
  const row = requireApplicationAuthority(m, principal, parent);
  if (
    origin?.applicationId !== row.binding.applicationId ||
    origin.channelId !== row.binding.channelId ||
    origin.actor !== row.binding.actor ||
    authorization?.basis !== 'user-instruction' ||
    authorization.sourceMessageRef !== row.sourceMessageRef ||
    authorization.userAuthorizationQuote !== row.authorizationQuote
  )
    delegationRefused('Application input does not match its attested human authorization');
}

/** A run's other lifecycle controls must not bypass its issuer through a generic endpoint. */
export function authorizeApplicationMutation(
  m: MachineConfig,
  principal: ChatPrincipal,
  target: z.infer<typeof ManagedPeerSchema>,
  allowEnded = false,
): void {
  const child = controlTarget(m, target),
    root = child.delegation?.applicationAuthority;
  if (root === undefined) return;
  if (principal.kind !== 'managed') {
    requireApplicationAuthority(m, principal, root, allowEnded);
    return;
  }
  const parent = controlTarget(m, principal);
  if (
    child.delegation?.parent.target.kind !== 'managed' ||
    !sameTarget(principal, child.delegation.parent.target) ||
    parent.registrationGeneration !== child.delegation.parent.registrationGeneration ||
    stableJson(parent.delegation?.applicationAuthority) !== stableJson(root) ||
    (!allowEnded && applicationAuthorityEnded(m, root))
  )
    delegationRefused('Application mutation requires its issuer or exact managed parent');
}
