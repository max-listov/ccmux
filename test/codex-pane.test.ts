import { describe, expect, test } from 'bun:test';
import { inspectChatPane, inspectNativeCodexInput, scanPane } from '../src/agent/codex/pane.ts';
import frames from './fixtures/codex-pane/v0.147.0.json';

describe('Codex pane state machine from real 0.147.0 frame shapes', () => {
  test('only the structural idle composer is deliverable', () => {
    expect(inspectChatPane(frames.idle).state).toBe('deliverable');
    expect(scanPane(frames.idle)).toMatchObject({ ready: true, state: 'idle', atPrompt: null });
  });

  test('a running turn is held even though the composer shows an empty suggestion', () => {
    expect(inspectChatPane(frames.working)).toMatchObject({ state: 'working' });
    expect(scanPane(frames.working).state).toBe('working');
  });

  test('queued follow-up input is distinct from both an empty working composer and idle input', () => {
    expect(inspectChatPane(frames.queued)).toMatchObject({ state: 'queued-input' });
    expect(scanPane(frames.queued).state).toBe('working');
  });

  test('real undimmed composer input is held byte-for-byte', () => {
    expect(inspectChatPane(frames.partial)).toMatchObject({ state: 'input-busy' });
    expect(inspectChatPane(frames.partialWithDimCompletion)).toMatchObject({ state: 'input-busy' });
    expect(scanPane(frames.partial)).toMatchObject({ ready: true, state: 'idle' });
  });

  test('a multiline draft with an empty first line still occupies the native composer', () => {
    const pane = '› \n  unsent second line\n\n  gpt-5.6 · /tmp/demo';
    expect(inspectNativeCodexInput(pane).state).toBe('input-busy');
    expect(inspectChatPane(pane).state).toBe('input-busy');
  });

  test('an anchored selection prompt is a menu, not generic idle', () => {
    expect(inspectChatPane(frames.menu)).toMatchObject({ state: 'menu' });
    expect(inspectChatPane(frames.commandApproval)).toMatchObject({ state: 'menu' });
    expect(scanPane(frames.menu)).toMatchObject({
      ready: true,
      state: 'indeterminate',
      atPrompt: 'Hooks need review',
    });
  });

  test('blank and unfamiliar frames fail closed', () => {
    expect(inspectChatPane(frames.notDrawn).state).toBe('not-drawn');
    expect(inspectChatPane(frames.reconnectOverlay).state).toBe('unknown');
    expect(inspectChatPane(frames.unknown).state).toBe('unknown');
    expect(scanPane(frames.unknown)).toMatchObject({ ready: false, state: 'indeterminate' });
  });

  test('prompt-like scrollback without bottom confirmation is not a live menu', () => {
    const adversarial = `${frames.idle}\nEarlier output said: 1. Approve request`;
    expect(inspectChatPane(adversarial).state).toBe('deliverable');
    expect(scanPane(adversarial).atPrompt).toBeNull();
  });

  test('a completed menu in scrollback loses to the newer idle composer', () => {
    const resumed = `${frames.menu}\n${frames.idle}`;
    expect(inspectChatPane(resumed).state).toBe('deliverable');
    expect(scanPane(resumed).atPrompt).toBeNull();
  });

  test('a completed Working animation in scrollback loses to its Worked for boundary', () => {
    const completed = `${frames.working}\n─ Worked for 7s ─\n${frames.idle}`;
    expect(inspectChatPane(completed).state).toBe('deliverable');
  });
});
