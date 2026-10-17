import { cursorNumber } from '../agent/claude/menuStep.ts';
import { detectPrompt } from '../agent/claude/prompts.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { hasNoComposer } from '../runtime/modes.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { capturePaneScreen, sendKeysLiteral, sendKeysNamed } from '../tmux/tmux.ts';
import { preview } from '../util/preview.ts';

/** Long, prose-looking text aimed at a session that could have received it as CHAT. `send` types
 *  keystrokes: no sender, no record, no reply address, and none of the delivery gates (it will type
 *  into a selection menu or onto a human's half-written line). That is right for `/compact` and
 *  wrong for a letter — and the difference is invisible from the command name, which is exactly how
 *  a careful agent ends up using it for a multi-paragraph review request. */
export function looksLikeMessage(text: string, recipientChatEnabled: boolean): boolean {
  return recipientChatEnabled && text.length > 200 && !text.trimStart().startsWith('/');
}

/**
 * Why typing this into the pane would be wrong right now, or null when it would not.
 *
 * `send` types text and then Enter. At a menu that draws no numbers — the form Claude's folder-trust
 * question takes — the Enter picks whatever the cursor is on, and the cursor starts on the refusal
 * as often as on the acceptance: the session exits and is blocked for a conversation it never had.
 * A numbered menu is the documented use (`send <name> 1`), because the number names the option.
 */
export function menuRefusal(screen: string, text: string, name: string): string | null {
  const prompt = detectPrompt(screen);
  if (prompt === null) return null;
  if (cursorNumber(screen) !== null && /^\d{1,2}$/.test(text.trim())) return null;
  return (
    `send: ${name} is waiting at a menu (${prompt.title}); text and Enter would select the highlighted option. ` +
    'The supervisor answers trust and resume menus itself (machine config trustPrompt, resumePicker). ' +
    'A recognised menu is read with the control operation terminal.prompt and answered with terminal.respond; a numbered menu takes its number: ccmux send ' +
    `${name} 1`
  );
}

export async function cmdSend(
  name: string | undefined,
  keys: string[],
  opts: { internal?: boolean } = {},
): Promise<number> {
  if (!name || keys.length === 0) {
    console.log(
      'usage: ccmux send <name> <keys...>   ·   <machine>:<name> for another fleet machine',
    );
    return 1;
  }
  const fwd = await forwardIfRemote(name, 'send', keys);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const target = findSession(loadSessions(m), name);
  // The address first, and from the registry rather than from tmux. Without this the verdict was
  // right by accident: an unknown name fell through to typing into a pane that does not exist, and
  // only tmux's own failure produced the non-zero — under the message "not running?", which blames
  // the session's state for what is a miss by address.
  if (target === undefined) {
    console.error(`unknown session: ${name}`);
    return 1;
  }
  if (hasNoComposer(target)) {
    console.error(
      'send: this runtime has no terminal composer. Write to it with `msg`, and run a slash command ' +
        'with the control service `command` operation (`commands` lists what it offers).',
    );
    return 1;
  }
  const text = keys.join(' ');
  if (target.agent === 'claude') {
    const refused = menuRefusal(await capturePaneScreen(m, name).catch(() => ''), text, name);
    if (refused !== null) {
      console.error(refused);
      return 1;
    }
  }
  const ok = await sendKeysLiteral(m, name, text);
  if (!ok) {
    console.log(`send failed: ${name} not running?`);
    return 1;
  }
  // let readline drain the literal text before the separate Enter (avoids a race)
  await Bun.sleep(150);
  await sendKeysNamed(m, name, 'Enter');
  // Preview, not an echo: repeating the whole text back charges twice for the same words, which is
  // nothing for a slash command and a lot for a long message.
  console.log(`sent to ${name}: ${preview(text)}`);
  // Not a refusal — pasting long text on purpose is legitimate. But say it once, here, where the
  // choice was made; `internal` keeps ccmux-owned key injection from lecturing.
  if (
    opts.internal !== true &&
    looksLikeMessage(
      text,
      (() => {
        const t = findSession(loadSessions(m), name);
        return t !== undefined && chatEnabledFor(t, m);
      })(),
    )
  ) {
    console.log(
      `  note: that reads like a message, not keystrokes — \`ccmux msg ${name} "…"\` tags you as the sender,`,
    );
    console.log(
      '        gives them a reply address, records it, and waits for a safe moment to deliver.',
    );
  }
  return 0;
}
