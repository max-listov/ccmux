import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorsUnreadableError, loadCursors, markRead, saveCursors } from '../src/chat/cursors.ts';
import { managedPeerKey } from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/ledger.ts';
import { chatPaths } from '../src/chat/store.ts';
import { makeChatMessage, makeMachine, makePeer } from './helpers.ts';

/**
 * The chat state has one job the rest of delivery leans on: never make a letter look undelivered
 * once it was delivered, and never make it look delivered when it was not. Each test here is one
 * way the state used to do the first — replaying a whole history into live agents — or lose a write.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function machine() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-chat-state-'));
  roots.push(root);
  return makeMachine({ stateDir: root, rcPrefix: 'host-a' });
}

const worker = makePeer({ session: 'worker' });
const letter = (n: number) =>
  makeChatMessage({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    to: worker,
    body: `letter ${n}`,
  });

test('unreadable cursors refuse to answer instead of answering "nothing delivered yet"', () => {
  const m = machine();
  for (const n of [1, 2, 3]) appendMessage(m, letter(n));
  const { cursors } = chatPaths(m);
  writeFileSync(cursors, '{ "delivered": {'); // torn by something other than this program
  expect(() => loadCursors(m)).toThrow(CursorsUnreadableError);
  // A shape this build does not accept is the same answer, not an empty one.
  writeFileSync(cursors, JSON.stringify({ delivered: { [managedPeerKey(worker)]: 'three' } }));
  expect(() => loadCursors(m)).toThrow(CursorsUnreadableError);
  expect(() => loadCursors(m)).toThrow('delivery is held');
});

test('a ledger without cursors resumes at the present, and the present stays put', () => {
  const m = machine();
  for (const n of [1, 2, 3]) appendMessage(m, letter(n));
  rmSync(chatPaths(m).cursors); // lost by hand: the case that used to replay everything
  const armed = loadCursors(m);
  expect(armed.delivered[managedPeerKey(worker)]).toBe(3);
  expect(armed.read[managedPeerKey(worker)]).toBe(3);
  // Persisted: a letter written after this is ahead of the cursor, not swallowed by a later re-arm.
  appendMessage(m, letter(4));
  expect(loadCursors(m).delivered[managedPeerKey(worker)]).toBe(3);
});

test('the first letter on a new machine is ahead of its cursors, not behind them', () => {
  const m = machine();
  appendMessage(m, letter(1));
  expect(loadCursors(m).delivered[managedPeerKey(worker)] ?? 0).toBe(0);
});

test("the daemon's save does not undo a read marked while it held stale cursors", async () => {
  const m = machine();
  for (const n of [1, 2, 3, 4, 5]) appendMessage(m, letter(n));
  const key = managedPeerKey(worker);
  const held = loadCursors(m); // the daemon starts its pass
  await markRead(m, worker, 5); // `ccmux inbox` marks everything read meanwhile
  held.delivered[key] = 2;
  await saveCursors(m, held); // the daemon saves at the end of its pass
  const now = loadCursors(m);
  expect(now.read[key]).toBe(5);
  expect(now.delivered[key]).toBe(2);
});

test("marking read does not undo the daemon's pickup record", async () => {
  const m = machine();
  for (const n of [1, 2]) appendMessage(m, letter(n));
  const key = managedPeerKey(worker);
  const cursors = loadCursors(m);
  cursors.pickups[key] = {
    messageId: letter(2).id,
    injectedAt: '2026-09-23T00:00:00.000Z',
    ledgerIndex: 1,
    conditional: false,
  };
  await saveCursors(m, cursors);
  await markRead(m, worker, 2);
  expect(loadCursors(m).pickups[key]?.messageId).toBe(letter(2).id);
});

test('receivers in separate processes admit one id once', async () => {
  // Processes, not promises: inside one process the check and the append run without a yield between
  // them, so no lock is needed and none would be tested. The race is between receiver processes.
  const m = machine();
  const script = join(m.stateDir, 'admit.ts');
  writeFileSync(
    script,
    `import { appendMessageOnce } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'chat', 'ledger.ts'))};
const [m, msg] = JSON.parse(process.argv[2]);
await Bun.sleep(Number(process.argv[3]));
console.log(await appendMessageOnce(m, msg));`,
  );
  const runs = Array.from({ length: 6 }, (_, i) =>
    Bun.spawn(['bun', script, JSON.stringify([m, letter(7)]), String(i % 2)], { stdout: 'pipe' }),
  );
  const said = await Promise.all(
    runs.map(async (run) => (await new Response(run.stdout).text()).trim()),
  );
  expect(said.filter((word) => word === 'true')).toHaveLength(1);
  expect(loadLedger(m)).toHaveLength(1);
});

test('a record still being written is not a record yet; damage in the middle still fails loud', () => {
  const m = machine();
  appendMessage(m, letter(1));
  const { ledger } = chatPaths(m);
  const whole = JSON.stringify(letter(2));
  appendFileSync(ledger, whole.slice(0, 40)); // a reader that overtook the writer sees this much
  expect(loadLedger(m).map((slot) => slot?.body)).toEqual(['letter 1']);
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}\n${JSON.stringify(letter(3))}\n`);
  expect(() => loadLedger(m)).toThrow('chat ledger:2 — invalid JSON');
});
