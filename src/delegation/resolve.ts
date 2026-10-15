import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { AppError } from 'stitchkit';
import { stableJson } from '../agent/launch/launchInputs.ts';
import { sameTarget } from '../chat/identity.ts';
import { controlTarget } from '../control/target.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { MachineConfig, Session } from '../types.ts';
import { type DelegatedPolicy, type DelegationRequest, DelegationSchema } from './schema.ts';

export function delegationRefused(message: string): never {
  throw new AppError('DELEGATION_REFUSED', { message, status: 409 });
}
export function withinWorkspace(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'));
}
export function narrowPolicy(parent: DelegatedPolicy, child: DelegatedPolicy): void {
  const ranks = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
  if (
    ranks[child.access] > ranks[parent.access] ||
    !withinWorkspace(parent.workspace, child.workspace)
  )
    delegationRefused('Child policy exceeds parent authority');
}
export function resolveDelegation(
  m: MachineConfig,
  runtime: string,
  mode: string,
  workspace: string,
  requestId: string,
  input: DelegationRequest,
) {
  if (!['codex', 'claude'].includes(runtime) || !['app-server', 'native'].includes(mode))
    delegationRefused('Delegation requires an owned native runtime');
  if (input.deadlineAt !== undefined && Date.parse(input.deadlineAt) <= Date.now())
    delegationRefused('Delegation deadline has expired');
  const parent = controlTarget(m, input.parent.target);
  if (parent.archived || parent.registrationGeneration !== input.parent.registrationGeneration)
    delegationRefused('Parent registration is unavailable');
  if (!hasNativeRuntime(parent)) delegationRefused('Parent has no owned native runtime');
  const inherited =
    parent.delegation ??
    m.delegationAuthorities?.find(
      (grant) =>
        sameTarget(grant.parent.target, input.parent.target) &&
        grant.parent.registrationGeneration === input.parent.registrationGeneration,
    );
  const authority = inherited?.policy;
  if (authority === undefined) delegationRefused('Parent authority is not declared by this host');
  const canonicalRoot = realpathSync(authority.workspace);
  if (canonicalRoot !== authority.workspace || realpathSync(input.policy.workspace) !== workspace)
    delegationRefused('Policy workspace must be canonical and match the child');
  const policy = { ...input.policy, workspace };
  const parentDeadline = inherited?.deadlineAt;
  const deadlineAt =
    parentDeadline === undefined
      ? input.deadlineAt
      : input.deadlineAt === undefined
        ? parentDeadline
        : new Date(
            Math.min(Date.parse(parentDeadline), Date.parse(input.deadlineAt)),
          ).toISOString();
  if (deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now())
    delegationRefused('Parent delegation deadline has expired');
  narrowPolicy(authority, policy);
  if (policy.access === 'full-access' || (runtime === 'claude' && policy.access !== 'read-only'))
    delegationRefused('This runtime cannot enforce the requested policy');
  return DelegationSchema.parse({
    ...input,
    policy,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    requestId,
    policyDigest: createHash('sha256').update(stableJson(policy)).digest('hex'),
  });
}
/** Immutable policy is checked at every native launch, including cold resumes. */
export function verifyDelegatedSession(session: Session): void {
  if (session.delegation === undefined) return;
  const delegation = DelegationSchema.parse(session.delegation);
  if (
    delegation.policy.workspace !== realpathSync(session.dir) ||
    delegation.policyDigest !==
      createHash('sha256').update(stableJson(delegation.policy)).digest('hex')
  )
    delegationRefused('Accepted execution policy changed');
}
