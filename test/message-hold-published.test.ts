import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageOperationEvidenceSchema } from '../src/chat/messageOperationSchema.ts';

const evidence = (over: Record<string, unknown> = {}) => ({
  state: 'queued' as const,
  nativeSession: { runtime: 'claude' as const, id: 'n1' },
  turnId: null,
  continuations: [],
  pendingApprovals: [],
  observedAt: '2026-09-02T09:00:00.000Z',
  expiresAt: null,
  ...over,
});

test('a held message publishes WHY, as a value and as a sentence', () => {
  const held = MessageOperationEvidenceSchema.parse(
    evidence({
      hold: {
        kind: 'menu',
        text: 'recipient is at a selection menu — injecting would pick an option it never chose',
        heldForMs: 79_200_000,
      },
    }),
  );
  // The kind is what a consumer branches on: a recipient in a menu needs a person, one mid-turn
  // needs only time, and `queued` says the same thing for both.
  expect(held.hold?.kind).toBe('menu');
  expect(held.hold?.text).toContain('selection menu');
  // And how long, from the first hold of this same letter — "stuck for twenty-two hours" and
  // "stuck for three seconds" are the same word without it.
  expect(held.hold?.heldForMs).toBe(79_200_000);
});

test('not held is null, and an older consumer that sends no hold still parses', () => {
  // Null is "the daemon is not holding this", which is not the same as "it is moving" — the field
  // is nullable rather than defaulted to anything reassuring.
  expect(MessageOperationEvidenceSchema.parse(evidence({ hold: null })).hold).toBeNull();
  // Absent entirely: a record written before this field existed must still be readable, and must
  // not claim a hold nobody recorded.
  expect(MessageOperationEvidenceSchema.parse(evidence()).hold).toBeNull();
});

test('the kind vocabulary is closed, so a consumer can exhaust it', () => {
  // An open string is what this replaced. A value outside the vocabulary is refused rather than
  // passed through, because a consumer that branches on it has no branch for a surprise.
  expect(() =>
    MessageOperationEvidenceSchema.parse(
      evidence({ hold: { kind: 'sleepy', text: 'x', heldForMs: 0 } }),
    ),
  ).toThrow();
  // `other` is the honest catch-all: a hold recorded before the field existed, or by a site with no
  // kind of its own. It means "the text is all there is", never "nothing is wrong".
  expect(
    MessageOperationEvidenceSchema.parse(
      evidence({ hold: { kind: 'other', text: 'x', heldForMs: 0 } }),
    ).hold?.kind,
  ).toBe('other');
});

test('the kind survives the round trip to disk, and an older record defaults honestly', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-hold-roundtrip-'));
  // The status path is a module-level constant derived from the environment, so the round trip is
  // exercised where that environment can be set: in a child, not by reaching around the module.
  const script = `
    const { writeChatHold, readChatHold } = await import(${JSON.stringify(
      join(import.meta.dir, '..', 'src', 'agent', 'sessionStatus.ts'),
    )});
    await writeChatHold('agent-a', 'm1', 'recipient is at a selection menu', 'menu');
    const held = readChatHold('agent-a');
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // A record written before the field existed: only prose on disk.
    writeFileSync(
      join(process.env.CCMUX_STATE_DIR, 'status', 'agent-b.chathold.json'),
      JSON.stringify({ reason: 'older record', ts: Date.now(), msgId: 'm2' }),
    );
    console.log(JSON.stringify({ held, older: readChatHold('agent-b') }));
  `;
  const proc = Bun.spawn(['bun', '-e', script], {
    env: { ...process.env, CCMUX_STATE_DIR: stateDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, `child failed: ${err}`).toBe(0);
  const { held, older } = JSON.parse(out.trim()) as {
    held: { kind: string; reason: string } | null;
    older: { kind: string; reason: string } | null;
  };

  expect(held?.kind).toBe('menu');
  expect(held?.reason).toContain('selection menu');
  // Not 'menu', not a guess: a record with no kind gets the one that says the text is all there is.
  expect(older?.kind).toBe('other');
  expect(older?.reason).toBe('older record');
  rmSync(stateDir, { recursive: true, force: true });
});
