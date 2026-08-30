import type { CodexAppRpc } from '../agent/codex/rpc.ts';
import { chatPrincipalKey } from '../chat/identity.ts';
import { findOwnedCodexReceipt } from '../chat/ownedCodexReceipt.ts';
import type { ChatPrincipal, MachineConfig, Session } from '../types.ts';
import {
  type SteeringJournal,
  type SteeringOperation,
  type SteeringReceipt,
  SteeringReceiptSchema,
} from './schema.ts';
import { steeringFailure, writeSteeringJournal } from './store.ts';

export function priorSteering(
  journal: SteeringJournal,
  principal: ChatPrincipal,
  operationId: string,
  fingerprint?: string,
): SteeringOperation | null {
  const prior = journal.operations.find((row) => row.receipt.operationId === operationId);
  if (!prior) return null;
  if (
    prior.principal !== chatPrincipalKey(principal) ||
    (fingerprint !== undefined && prior.fingerprint !== fingerprint)
  )
    return steeringFailure('IDEMPOTENCY_CONFLICT');
  return prior;
}

/** A bounded negative lookup is not permission to replay. Only positive native identity reconciles. */
export async function reconcileSteering(
  m: MachineConfig,
  s: Session,
  journal: SteeringJournal,
  operation: SteeringOperation,
  connect: () => Promise<CodexAppRpc>,
): Promise<SteeringReceipt> {
  if (operation.phase === 'submitted') return operation.receipt;
  let rpc: CodexAppRpc | null = null;
  let accepted = false;
  try {
    rpc = await connect();
    const found = await findOwnedCodexReceipt(rpc, s.uuid, operation.receipt.clientUserMessageId);
    accepted = found?.id === operation.receipt.turnId;
  } catch {
    /* An absent or unreachable proof retains uncertainty; nothing is reinjected. */
  } finally {
    rpc?.close();
  }
  operation.phase = accepted ? 'submitted' : 'uncertain';
  operation.reason = accepted ? null : 'native-acceptance-unresolved';
  operation.receipt = SteeringReceiptSchema.parse({
    ...operation.receipt,
    state: operation.phase,
    observedAt: new Date().toISOString(),
  });
  writeSteeringJournal(m, s, journal);
  return operation.receipt;
}
