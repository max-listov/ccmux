import { expect, test } from 'bun:test';
import { menuRefusal } from '../src/commands/send.ts';

// `send` types text and Enter. At a menu without numbers the Enter picks the highlighted option,
// and the highlighted option of the folder-trust question is, half the time, "No, exit".

const UNNUMBERED = `
 Quick safety check: Is this a project you created or one you trust?
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;
const NUMBERED = `
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Enter to confirm · Esc to cancel
`;
const COMPOSER = `
──────
❯ 
──────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

test('text and Enter are not typed into a menu that draws no numbers', () => {
  const why = menuRefusal(UNNUMBERED, 'Down', 'agent-A');
  expect(why).toContain('waiting at a menu');
  expect(why).toContain('terminal.respond');
  // Even a lone digit has no option to name there.
  expect(menuRefusal(UNNUMBERED, '1', 'agent-A')).not.toBeNull();
});

test('a numbered menu still takes its number, and nothing else', () => {
  expect(menuRefusal(NUMBERED, '1', 'agent-A')).toBeNull();
  expect(menuRefusal(NUMBERED, 'yes please', 'agent-A')).not.toBeNull();
});

test('an ordinary pane is never refused — slash commands are the point of send', () => {
  expect(menuRefusal(COMPOSER, '/compact', 'agent-A')).toBeNull();
  expect(menuRefusal('', '/compact', 'agent-A')).toBeNull();
});
