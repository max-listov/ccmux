import type { ChatMessage } from "../types.ts";

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
  const sender = msg.fromMachine !== null ? `${msg.fromMachine}:${msg.from}` : msg.from;
  const reply =
    msg.fromMachine !== null && opts?.replyable === true
      ? // The body placeholder matters: the prompt says to use this command verbatim, and a command
        // without one runs as an empty send — usage error, exit 1 — right when the agent is trying
        // to answer.
        ` · reply: ${opts.cli ?? "ccmux"} msg ${sender}${msg.task ? ` --task ${msg.task}` : ""} "<your reply>"`
      : "";
  return `[chat from ${sender}${behalf}${task}${reply}] ${msg.body}`;
}
