import { ADDRESS_ENV, SESSION_ENV } from '../agent/launch/identityEnv.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { selfAddress } from '../fleet/address.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { typeKeys } from '../session/keys.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { preview } from '../util/preview.ts';

/** Long, prose-looking text aimed at a session that could have received it as CHAT. `send` types
 *  keystrokes: no sender, no record, no reply address, and none of the delivery gates (it will type
 *  into a selection menu or onto a human's half-written line). That is right for `/compact` and
 *  wrong for a letter — and the difference is invisible from the command name, which is exactly how
 *  a careful agent ends up using it for a multi-paragraph review request. */
export function looksLikeMessage(text: string, recipientChatEnabled: boolean): boolean {
  return recipientChatEnabled && text.length > 200 && !text.trimStart().startsWith('/');
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
  const text = keys.join(' ');
  const refused = await typeKeys(
    m,
    target,
    text,
    process.env[ADDRESS_ENV] ??
      (process.env[SESSION_ENV] === undefined ? 'cli' : selfAddress(m, process.env[SESSION_ENV])),
  );
  if (refused !== null) {
    // A session that is down is a state, said on stdout; a refusal is a mistake, said on stderr.
    if (refused.reason === 'not-running') console.log(refused.message);
    else console.error(refused.message);
    return 1;
  }
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
