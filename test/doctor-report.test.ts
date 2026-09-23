import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorText } from '../src/commands/doctor.ts';
import { makeChatMessage, makeMachine } from './helpers.ts';

/**
 * `doctor --json` and the text are one report, rendered twice. The JSON used to be built separately
 * and returned before the chat and menu checks ran, so the machine reader was told nothing was wrong
 * exactly when the human reader was told something was.
 */
const root = mkdtempSync(join(tmpdir(), 'ccmux-doctor-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
const configPath = join(root, 'machine.json');
writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
writeFileSync(join(root, 'sessions.jsonl'), '# v2\n');
// One record from a newer build, and cursors that cannot be read.
writeFileSync(
  join(root, 'chat.jsonl'),
  `${JSON.stringify(makeChatMessage())}\n${JSON.stringify({ ...makeChatMessage(), v: 99 })}\n`,
);
writeFileSync(join(root, 'chat-cursors.json'), '{ "delivered": ');

async function doctor(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'doctor', ...args], {
    env: { ...process.env, CCMUX_CONFIG: configPath, CCMUX_STATE_DIR: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

test('the chat checks reach the JSON, and the text says the same', async () => {
  const report = JSON.parse(await doctor('--json'));
  expect(report.chat.unreadableRecords).toBe(1);
  expect(report.chat.stalled).toBeNull(); // not knowable while the cursors are unreadable — not "none"
  expect(report.chat.problems).toHaveLength(1);
  expect(report.chat.problems[0]).toContain('chat cursors unreadable');
  expect(report.deps.tmux).toBe(false);
  expect(report.atPrompt).toBeNull(); // no tmux here: unknown, not "nobody"
  const text = await doctor();
  expect(text).toBe(`${doctorText(report).join('\n')}\n`);
  expect(text).toContain('chat:   PROBLEM — chat cursors unreadable');
  expect(text).toContain('1 ledger record(s) this ccmux cannot read');
  expect(text).toContain('tmux:   /bin/tmux (missing)');
});
