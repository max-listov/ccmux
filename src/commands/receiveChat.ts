import { supportsManagedInput } from '../agent/index.ts';
import { hasAuthenticatedRemoteAncestor } from '../chat/auth.ts';
import { resolveCodexAppPeer } from '../chat/codexApp.ts';
import { requireCommunicationAuthorization } from '../chat/communicationAuthorization.ts';
import { managedPeer, principalLabel, targetLabel } from '../chat/identity.ts';
import { principalOrigin } from '../chat/origin.ts';
import { appendMessageOnce } from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { ChatMessageSchema } from '../config/schema.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import type { ChatMessage } from '../types.ts';
import { assertExpected } from './messagePeers.ts';

/** Transport-only v2 receiver. Old binaries reject the unknown verb before appending anything. */
export async function cmdReceiveChat(
  transportAuthenticated?: boolean,
  rawInput?: string,
): Promise<number> {
  const machine = loadMachineConfig();
  if (process.env.CCMUX_SESSION !== undefined) {
    console.error('chat receive is transport-only');
    return 1;
  }
  if (!(transportAuthenticated ?? hasAuthenticatedRemoteAncestor(machine))) {
    console.error('chat receive is only admitted from an authenticated remote transport');
    return 1;
  }
  let message: ChatMessage;
  try {
    message = ChatMessageSchema.parse(JSON.parse(rawInput ?? (await Bun.stdin.text())));
  } catch {
    console.error('chat receive: invalid v2 envelope');
    return 1;
  }
  if (message.to.kind !== 'managed' && message.to.kind !== 'codex-app') {
    console.error('chat receive: remote owner target is not allowed');
    return 1;
  }
  try {
    // Raw envelopes cannot attest a human application channel; that exception is admitted only
    // by the control service against its local application bindings.
    requireCommunicationAuthorization(
      message.from,
      principalOrigin(message.from),
      message.communicationAuthorization,
    );
  } catch {
    console.error('chat receive: communicationAuthorization is required');
    return 1;
  }
  if (message.to.machine !== machine.rcPrefix) {
    console.error(
      `chat receive: target machine mismatch (${message.to.machine} != ${machine.rcPrefix})`,
    );
    return 1;
  }
  if (message.to.kind === 'managed') {
    const session = findSession(loadSessions(machine), message.to.session);
    if (!session) {
      console.error(`chat receive: target session '${message.to.session}' no longer exists`);
      return 1;
    }
    const current = managedPeer(machine.rcPrefix, session);
    const mismatch = assertExpected(current, message.to.agent, message.to.threadId);
    if (mismatch !== null) {
      console.error(`chat receive: ${mismatch}`);
      return 1;
    }
    if (!chatEnabledFor(session, machine) || !supportsManagedInput(session)) {
      console.error(`chat receive: target '${session.name}' cannot receive chat`);
      return 1;
    }
  } else {
    try {
      const current = await resolveCodexAppPeer(machine, message.to.threadId);
      const mismatch = assertExpected(current, message.to.agent, message.to.threadId);
      if (mismatch !== null) {
        console.error(`chat receive: ${mismatch}`);
        return 1;
      }
    } catch (error) {
      console.error(
        `chat receive: App thread unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
      return 1;
    }
  }
  if (!(await appendMessageOnce(machine, message))) {
    console.log(`already delivered (${message.id}) — retry ignored`);
    return 0;
  }
  console.log(`accepted ${principalLabel(message.from)} → ${targetLabel(message.to)}`);
  return 0;
}
