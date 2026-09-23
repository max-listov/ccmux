import { resolveMessageAttachments } from '../../../attachments/pins.ts';
import { nativeDeliveryHold } from '../../../chat/settlement.ts';
import { contextMutationPending } from '../../../context/store.ts';
import { tryNativeAdmission } from '../../../runtime/admission.ts';
import { type RuntimeInput, readRuntimeInput, writeRuntimeInput } from '../../../runtime/input.ts';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../../runtime/interrupt.ts';
import type { NativeSnapshot } from '../../../runtime/projectionSchema.ts';
import { loadSessions } from '../../../session/registry.ts';
import { clearChatHold, writeChatHold } from '../../../session/status.ts';
import {
  capturePaneStyled,
  clientTypingRecently,
  setPaneInputEnabled,
} from '../../../tmux/tmux.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { log } from '../../../util/log.ts';
import {
  appThreadHoldReason,
  prepareManagedCodexTurn,
  readCodexAppThread,
  resumeCodexAppThreadContext,
  startCodexAppTurn,
} from '../appServer.ts';
import { inspectNativeCodexInput } from '../pane.ts';
import type { CodexAppRpc } from '../rpc.ts';
import { codexTextInput } from '../turnInput.ts';
import { findOwnedCodexReceipt } from './receipt.ts';

/**
 * The owned-Codex owner's side of the session mailboxes: it starts the turn the daemon queued, and
 * stops the turn a caller asked it to stop.
 *
 * The daemon decides WHICH letter is next and writes it to `runtime/input`, as it does for every
 * native runtime; the owner decides WHEN, because only the owner can see what is in its way. Its
 * pane carries the provider's TUI client, where a person may be typing: a turn started under their
 * half-written line lands in the conversation as theirs. So the owner holds that pane's input for
 * the moment of submission, reads it, and starts the turn only over an empty composer.
 */
export const ownedInputDependencies = {
  sessions: loadSessions,
  typing: clientTypingRecently,
  gate: setPaneInputEnabled,
  capture: capturePaneStyled,
  hold: writeChatHold,
  clearHold: clearChatHold,
};

/**
 * Start the queued turn, or settle one whose start was cut short. True when a turn was started.
 *
 * `dispatching` is written before `turn/start` and `accepted` after, so a start whose response was
 * lost is visible on the next tick as a dispatch in flight. The provider's own record decides what
 * it was — a turn carrying this message's client id — and a missing record makes it `uncertain`,
 * never a second start: the same message twice is a worse failure than one that needs a person.
 */
export async function applyOwnedCodexInput(
  m: MachineConfig,
  session: Session,
  rpc: CodexAppRpc,
  snapshot: () => NativeSnapshot,
  deps = ownedInputDependencies,
): Promise<boolean> {
  let started = false;
  await tryNativeAdmission(m, session, async () => {
    try {
      started = await applyLocked(m, session, rpc, snapshot, deps);
    } catch (error) {
      // The failure is this letter's hold, where a sender looking at it will read it; the journal
      // keeps whatever phase it reached, and the next tick settles it from there.
      const input = readRuntimeInput(m, session);
      if (input !== null) await deps.hold(session.name, input.messageId, nativeDeliveryHold(error));
      throw error;
    }
  });
  return started;
}

async function applyLocked(
  m: MachineConfig,
  session: Session,
  rpc: CodexAppRpc,
  snapshot: () => NativeSnapshot,
  deps: typeof ownedInputDependencies,
): Promise<boolean> {
  const input = readRuntimeInput(m, session);
  if (input === null || input.phase === 'accepted') return false;
  if (input.phase === 'dispatching') {
    await settleDispatch(m, session, rpc, input);
    return false;
  }
  // Uncertain waits for a person, or for the provider's record to turn up on a later read.
  if (input.phase === 'uncertain') {
    const receipt = await findOwnedCodexReceipt(rpc, session.uuid, input.messageId);
    if (receipt !== null)
      await writeRuntimeInput(m, session, { ...input, phase: 'accepted', turnId: receipt.id });
    return false;
  }
  const hold = (reason: string) => deps.hold(session.name, input.messageId, reason);
  const observed = snapshot();
  if (contextMutationPending(m, session)) return false;
  if (!observed.connected || observed.state !== 'idle' || observed.turn?.status === 'inProgress')
    return false;
  if (await deps.typing(m, session.name, 3)) {
    await hold('a human typed in that pane a moment ago');
    return false;
  }
  let gated = false;
  try {
    gated = await deps.gate(m, session.name, false);
    if (!gated) {
      await hold('native client input could not be gated');
      return false;
    }
    const inspection = inspectNativeCodexInput(await deps.capture(m, session.name, 40));
    if (inspection.state !== 'deliverable') {
      await hold(inspection.reason);
      return false;
    }
    const context =
      session.launchRecipe?.collaborationMode === undefined && input.turnOptions === undefined
        ? { thread: await readCodexAppThread(rpc, session.uuid) }
        : await resumeCodexAppThreadContext(rpc, session.uuid);
    const reason = appThreadHoldReason(context.thread);
    if (reason !== null || context.thread.status.type !== 'idle') {
      await hold(reason ?? 'native runtime is not idle');
      return false;
    }
    const current = deps.sessions(m).find((row) => row.name === session.name);
    if (
      current?.uuid !== session.uuid ||
      current.agent !== session.agent ||
      current.runtime !== session.runtime ||
      current.registrationGeneration !== session.registrationGeneration
    ) {
      await hold('managed identity changed before native submission');
      return false;
    }
    let policy: Awaited<ReturnType<typeof prepareManagedCodexTurn>>;
    try {
      policy = await prepareManagedCodexTurn(rpc, m, session, context, input.turnOptions?.options);
    } catch {
      await hold('managed collaboration policy is unavailable');
      return false;
    }
    const attachments = input.images?.length
      ? await resolveMessageAttachments(
          m,
          session,
          input.messageId,
          input.images,
          AbortSignal.timeout(5_000),
        )
      : [];
    await writeRuntimeInput(m, session, {
      ...input,
      phase: 'dispatching',
      dispatchedAt: new Date().toISOString(),
    });
    const turnInput = codexTextInput(input.text);
    for (const attachment of attachments)
      turnInput.push({ type: 'localImage', path: attachment.path });
    // The message id is the provider's client id for this turn: it is what finds the turn again
    // when this response is lost.
    const turnId = await startCodexAppTurn(rpc, session.uuid, input.messageId, turnInput, policy);
    await writeRuntimeInput(m, session, { ...input, phase: 'accepted', turnId });
    deps.clearHold(session.name);
    log.info({
      msg: 'native managed chat accepted',
      name: session.name,
      messageId: input.messageId,
      turnId,
    });
    return true;
  } finally {
    if (gated) await deps.gate(m, session.name, true);
  }
}

async function settleDispatch(
  m: MachineConfig,
  session: Session,
  rpc: CodexAppRpc,
  input: RuntimeInput,
): Promise<void> {
  const receipt = await findOwnedCodexReceipt(rpc, session.uuid, input.messageId);
  await writeRuntimeInput(
    m,
    session,
    receipt === null
      ? { ...input, phase: 'uncertain' }
      : { ...input, phase: 'accepted', turnId: receipt.id },
  );
}

/**
 * Stop the running turn a caller named, through the connection that started it.
 *
 * Checked twice around the `uncertain` write: persisting yields to provider events, and a turn that
 * settled in that interval must not be answered by interrupting whatever runs next.
 */
export async function applyOwnedCodexInterrupt(
  m: MachineConfig,
  session: Session,
  rpc: CodexAppRpc,
  snapshot: () => NativeSnapshot,
): Promise<void> {
  const command = readRuntimeInterrupt(m, session);
  if (command?.phase !== 'queued') return;
  const valid = () => isCancellableTurn(snapshot(), command.generation, command.turnId);
  const reject = () => writeRuntimeInterrupt(m, session, { ...command, phase: 'rejected' });
  if (!valid()) return reject();
  const thread = await readCodexAppThread(rpc, session.uuid);
  if (
    thread.status.type !== 'active' ||
    thread.status.activeFlags.some(
      (flag) => !['waitingOnApproval', 'waitingOnUserInput'].includes(flag),
    )
  )
    return reject();
  await writeRuntimeInterrupt(m, session, { ...command, phase: 'uncertain' });
  if (!valid()) return reject();
  await rpc.request('turn/interrupt', { threadId: session.uuid, turnId: command.turnId });
  await writeRuntimeInterrupt(m, session, { ...command, phase: 'accepted' });
}
