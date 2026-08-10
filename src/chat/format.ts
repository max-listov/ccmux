import type { ChatMessage } from "../types.ts";
import { principalLabel } from "./identity.ts";

/**
 * The SINGLE source of truth for how an injected chat message is framed to the recipient agent —
 * used by BOTH the daemon pane-delivery (src/chat/deliver.ts) and the Stop-hook injection
 * (src/commands/stopHook.ts), so the trust tag can never drift between the two channels.
 *
 * The `[chat from <name>]` tag is what managePrompt.ts teaches the agent to recognize as a PEER
 * message (peer-level trust, not the human). `onBehalfOf` carries HONEST provenance: when a courier
 * (the router) relays an owner instruction, the recipient sees "on behalf of owner" — the true
 * authority — while `from` still names the real (unspoofable) sender. Pure: message → framed line.
 */
export function formatChatInjection(msg: ChatMessage, opts?: { cli?: string; replyable?: boolean }): string {
  const task = msg.task ? ` · task: ${msg.task}` : "";
  const behalf = msg.onBehalfOf ? ` on behalf of ${msg.onBehalfOf}` : "";
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
  const reply =
    msg.from.kind === "cli" || opts?.replyable === undefined
      ? ""
      : opts.replyable
        ? // The body placeholder matters: the prompt says to use this command verbatim, and a command
          // without one runs as an empty send — usage error, exit 1 — right when the agent is trying
          // to answer.
          ` · reply: ${opts.cli ?? "ccmux"} msg ${msg.from.machine}:${msg.from.session} --to-agent ${msg.from.agent} --to-thread ${msg.from.threadId}${msg.task ? ` --task ${msg.task}` : ""} "<your reply>"`
        : ` · no route back to ${msg.from.machine} from here — answer with ${opts.cli ?? "ccmux"} msg owner "<your reply>"`;
  return `[chat from ${sender}${behalf}${task}${reply}] ${msg.body}`;
}
