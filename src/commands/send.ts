import { forwardIfRemote } from "../fleet/forward.ts";
import { sendKeysLiteral, sendKeysNamed } from "../tmux/tmux.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { preview } from "../util/preview.ts";
import { chatEnabledFor } from "../config/chat.ts";

/** Long, prose-looking text aimed at a session that could have received it as CHAT. `send` types
 *  keystrokes: no sender, no record, no reply address, and none of the delivery gates (it will type
 *  into a selection menu or onto a human's half-written line). That is right for `/compact` and
 *  wrong for a letter — and the difference is invisible from the command name, which is exactly how
 *  a careful agent ends up using it for a multi-paragraph review request. */
export function looksLikeMessage(text: string, recipientChatEnabled: boolean): boolean {
  return recipientChatEnabled && text.length > 200 && !text.trimStart().startsWith("/");
}

export async function cmdSend(name: string | undefined, keys: string[], opts: { internal?: boolean } = {}): Promise<number> {
  if (!name || keys.length === 0) {
    console.log("usage: ccmux send <name> <keys...>   ·   <machine>:<name> for another fleet machine");
    return 1;
  }
  const fwd = await forwardIfRemote(name, "send", keys);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const text = keys.join(" ");
  const ok = await sendKeysLiteral(m, name, text);
  if (!ok) {
    console.log(`send failed: ${name} not running?`);
    return 1;
  }
  // let readline drain the literal text before the separate Enter (avoids a race)
  await Bun.sleep(150);
  await sendKeysNamed(m, name, "Enter");
  // Preview, not an echo: repeating the whole text back charges twice for the same words, which is
  // nothing for a slash command and a lot for a long message.
  console.log(`sent to ${name}: ${preview(text)}`);
  // Not a refusal — pasting long text on purpose is legitimate. But say it once, here, where the
  // choice was made; `internal` keeps ccmux-owned key injection from lecturing.
  if (opts.internal !== true && looksLikeMessage(text, (() => { const t = findSession(loadSessions(m), name); return t !== undefined && chatEnabledFor(t, m); })())) {
    console.log(`  note: that reads like a message, not keystrokes — \`ccmux msg ${name} "…"\` tags you as the sender,`);
    console.log("        gives them a reply address, records it, and waits for a safe moment to deliver.");
  }
  return 0;
}
