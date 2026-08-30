import { expect, test } from 'bun:test';
import {
  capturePane,
  loadPasteBuffer,
  sendKeysLiteral,
  setPaneInputEnabled,
  submitPasteBuffer,
  tmuxArgv,
} from '../src/tmux/tmux.ts';
import { makeMachine } from './helpers.ts';

test('pane input cannot interleave with the classified chat paste+Enter queue', async () => {
  const tmuxBin = Bun.which('tmux');
  if (tmuxBin === null)
    throw new Error('tmux is required for the chat input-gate integration test');
  const m = makeMachine({ tmuxBin, tmuxSocket: `ccmux-chat-gate-${process.pid}` });
  const name = 'agent-b';
  Bun.spawnSync(tmuxArgv(m, 'new-session', '-d', '-s', name, 'sh'));
  try {
    const buffer = await loadPasteBuffer(m, 'printf peer-marker');
    expect(buffer).not.toBeNull();
    if (buffer === null) throw new Error('tmux failed to load the chat test buffer');
    expect(await setPaneInputEnabled(m, name, false)).toBe(true);

    // Models a client keystroke arriving after the final classifier sample. tmux accepts the
    // send-keys command, but the pane's input gate discards it before the atomic submission queue.
    expect(await sendKeysLiteral(m, name, 'human-marker')).toBe(true);
    expect(await submitPasteBuffer(m, name, buffer, '11111111-1111-4111-8111-111111111111')).toBe(
      true,
    );
    await Bun.sleep(100);

    const pane = await capturePane(m, name, 20);
    expect(pane).toContain('peer-marker');
    expect(pane).not.toContain('human-marker');
  } finally {
    Bun.spawnSync(tmuxArgv(m, 'kill-server'));
  }
});
