import { expect, test } from 'bun:test';
import { parseLifecycle } from '../src/commands/hookStatus.ts';

const L = (o: unknown): string => JSON.stringify(o);

test('maps turn-boundary events to authoritative working/idle', () => {
  expect(parseLifecycle(L({ hook_event_name: 'UserPromptSubmit' }), 1)?.state).toBe('working');
  expect(parseLifecycle(L({ hook_event_name: 'Stop' }), 1)?.state).toBe('idle');
  expect(parseLifecycle(L({ hook_event_name: 'SessionStart' }), 1)?.state).toBe('idle'); // resume/restart clears stale working
});

test('unmapped event / bad JSON → null (leave current status untouched)', () => {
  expect(parseLifecycle(L({ hook_event_name: 'PreToolUse' }), 1)).toBeNull();
  expect(parseLifecycle(L({ hook_event_name: 'Notification' }), 1)).toBeNull(); // waiting deferred, not mapped
  expect(parseLifecycle(L({}), 1)).toBeNull();
  expect(parseLifecycle('not json', 1)).toBeNull();
});

test('captures permission_mode / effort / transcript_path when present', () => {
  const s = parseLifecycle(
    L({
      hook_event_name: 'Stop',
      permission_mode: 'auto',
      effort: 'high',
      transcript_path: '/p/x.jsonl',
    }),
    42,
  );
  expect(s).toEqual({
    state: 'idle',
    ts: 42,
    event: 'Stop',
    permissionMode: 'auto',
    effort: 'high',
    transcriptPath: '/p/x.jsonl',
  });
});
