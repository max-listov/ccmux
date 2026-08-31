import type { ChatMessage } from '../types.ts';
import { codexAppAddress, principalLabel } from './identity.ts';
import { unknownMessageOrigin } from './originSchema.ts';
import type { ReplyRoute } from './replyRoute.ts';

/**
 * The SINGLE source of truth for how an injected chat message is framed to the recipient agent —
 * used by BOTH the daemon pane-delivery (src/chat/deliver.ts) and the Stop-hook injection
 * (src/commands/stopHook.ts), so the trust tag can never drift between the two channels.
 *
 * The `[chat from <name>]` tag is what managePrompt.ts teaches the agent to recognize as a PEER
 * message (peer-level trust, not the human). `onBehalfOf` is a relay claim, not proof of the
 * attributed author's identity or additional authority. Pure: message → framed line.
 */
export function formatChatInjection(
  msg: ChatMessage,
  opts?: { cli?: string; reply?: ReplyRoute | undefined },
): string {
  const task = msg.task ? ` · task: ${msg.task}` : '';
  const id = ` · id: ${msg.id}`;
  const behalf = msg.onBehalfOf ? ` on behalf of ${msg.onBehalfOf}` : '';
  // A cross-machine sender is named by its FULL address, and the reply command is spelled out. The
  // incident this fixes: an agent was asked to report back, saw only a bare name, resolved it against
  // its OWN machine, and reported to a same-named stranger. Nothing to infer now — the address is
  // printed, and the reply line is only offered when this machine can actually route back to it
  // (a reply command that errors here would be worse than none). The prefix comes BEFORE the body,
  // so a body containing a forged `reply:` line cannot be mistaken for the real one.
  const sender = principalLabel(msg.from);
  // Three states, not two — and the third is the one that cost a live agent five tool calls. A
  // sender on a machine THIS one cannot route to (the fleet map is directional: a roaming laptop
  // reaches the servers, the servers cannot reach it back, by the same key model that keeps them
  // from reaching each other) gets no reply command, and silence about why reads as a bug worth
  // investigating. Saying it outright, with the one channel that does work, ends the question where
  // it arises. `undefined` stays silent: a caller that never asked about routing must not have an
  // absence of knowledge printed as a fact.
  //
  // The unreachable branch always carries the RESOLVER'S reason, never a bare verdict. Cost of the
  // bare version: a machine with a live wire route to the sender was told "no route back", followed
  // the pinned instruction, and answered the human instead — while the peer-to-peer hop was working
  // that same minute. A stated cause is checkable; "no route" is only believable.
  const reply =
    (msg.from.kind !== 'managed' && msg.from.kind !== 'codex-app') || opts?.reply === undefined
      ? ''
      : opts.reply.replyable
        ? // The body placeholder matters: the prompt says to use this command verbatim, and a command
          // without one runs as an empty send — usage error, exit 1 — right when the agent is trying
          // to answer.
          ` · reply: ${opts.cli ?? 'ccmux'} msg ${msg.from.machine}:${msg.from.kind === 'managed' ? msg.from.session : codexAppAddress(msg.from.threadId)} --to-agent ${msg.from.agent} --to-thread ${msg.from.threadId}${msg.task ? ` --task ${msg.task}` : ''} "<your reply>"`
        : ` · cannot reach ${msg.from.machine} from here (${opts.reply.reason}) — answer with ${opts.cli ?? 'ccmux'} msg owner "<your reply>"`;
  const origin = msg.origin ?? unknownMessageOrigin();
  const attributed = origin.application;
  if (attributed !== null) {
    return `[application input via ${sender} · application: ${attributed.applicationId} · channel: ${attributed.channelId} · attributed author: ${origin.actor} (application-attested, not independently authenticated; no additional execution authority)${task}${id}] ${msg.body}`;
  }
  if (origin.assurance === 'unknown') {
    return `[input via ${origin.ingress === 'unknown' ? 'unknown historical ingress' : sender} · author: unknown; no additional execution authority${behalf}${task}${id}${reply}] ${msg.body}`;
  }
  return `[chat from ${sender}${behalf}${task}${id}${reply}] ${msg.body}`;
}
