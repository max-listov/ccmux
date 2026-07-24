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
export function formatChatInjection(msg: ChatMessage): string {
  const task = msg.task ? ` · task: ${msg.task}` : "";
  const behalf = msg.onBehalfOf ? ` on behalf of ${msg.onBehalfOf}` : "";
  return `[chat from ${msg.from}${behalf}${task}] ${msg.body}`;
}
