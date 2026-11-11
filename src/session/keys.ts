import { cursorNumber } from '../agent/claude/menuStep.ts';
import { detectPrompt } from '../agent/claude/prompts.ts';
import { hasNoComposer } from '../runtime/modes.ts';
import { capturePaneScreen, sendKeysLiteral, sendKeysNamed } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { recordSentKeys } from './sentKeys.ts';

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

/** Why keys were not typed: the runtime has no composer, a menu is open, or nothing is running. */
export type KeysRefusal = { reason: 'no-composer' | 'menu' | 'not-running'; message: string };

/**
 * Type text and Enter into a session's pane, and record that ccmux did it.
 *
 * Keystrokes carry no sender: without the record a reader of the conversation cannot tell this text
 * from one a person typed. `by` is who asked — an address, or `cli` for a person at a shell.
 */
export async function typeKeys(
  m: MachineConfig,
  target: Session,
  text: string,
  by: string,
): Promise<KeysRefusal | null> {
  const { name } = target;
  if (hasNoComposer(target))
    return {
      reason: 'no-composer',
      message:
        'send: this runtime has no terminal composer. Write to it with `msg`, and run a slash command ' +
        'with the control service `command` operation (`commands` lists what it offers).',
    };
  if (target.agent === 'claude') {
    const refused = menuRefusal(await capturePaneScreen(m, name).catch(() => ''), text, name);
    if (refused !== null) return { reason: 'menu', message: refused };
  }
  if (!(await sendKeysLiteral(m, name, text)))
    return { reason: 'not-running', message: `send failed: ${name} not running?` };
  // Recorded once the keys are in the pane: a reader of the conversation can then tell this text
  // from one a person typed.
  recordSentKeys(m, name, text, by);
  // let readline drain the literal text before the separate Enter (avoids a race)
  await Bun.sleep(150);
  await sendKeysNamed(m, name, 'Enter');
  return null;
}
