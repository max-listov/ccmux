import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../src/chat/auth.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import { managedPeer } from '../src/chat/identity.ts';
import {
  deliverableTargets,
  loadAckedIds,
  loadCursors,
  loadLedger,
  pendingConditional,
  pendingImmediate,
  saveCursors,
} from '../src/chat/store.ts';
import { chatAuthPath, outboxPath, sessionsPath } from '../src/config/paths.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { communicationAuthorizationFile } from './communication-fixture.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// Two chat-enabled router sessions (each may relay / arm watchdogs) + a worker target.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-cancel-'));
  const cfg = {
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'test',
    stateDir: dir,
    bootLabel: 'b',
  };
  const cfgPath = join(dir, 'machine.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const row = (name: string, extra: object) =>
    JSON.stringify({
      name,
      dir: '/tmp/x',
      uuid: randomUUID(),
      agent: 'claude',
      chatEnabled: true,
      ...extra,
    });
  const m = MachineConfigSchema.parse(cfg);
  writeFileSync(
    sessionsPath(m),
    `${row('router', { promptModules: ['router'] })}\n${row('router2', { promptModules: ['router'] })}\n${row('worker', {})}\n`,
  );
  for (const session of loadSessions(m)) rotateChatCredential(m, session);
  return { cfgPath, m };
}

async function runMsg(
  cfgPath: string,
  session: string | undefined,
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.CCMUX_CONFIG = cfgPath;
  if (session !== undefined) {
    env.CCMUX_SESSION = session;
    const m = MachineConfigSchema.parse(JSON.parse(await Bun.file(cfgPath).text()));
    const managed = loadSessions(m).find((item) => item.name === session);
    if (managed !== undefined)
      env[CHAT_CREDENTIAL_ENV] = (await Bun.file(chatAuthPath(m, managed.name)).text()).trim();
  } else delete env.CCMUX_SESSION;
  const proc = Bun.spawn(
    ['bun', CLI, 'msg', '--communication-authorization', communicationAuthorizationFile, ...args],
    {
      env,
      stdin: stdin !== undefined ? new Response(stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

test("msg cancel <task> tombstones this sender's undelivered mail for that task", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 't1', 'watchdog']);
  // one pending conditional before cancel
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't1' }).length).toBe(1);
  const { code, out } = await runMsg(cfgPath, 'router', ['cancel', 't1']);
  expect(code).toBe(0);
  expect(out).toContain('cancelled 1');
  // gone from pending; the ledger message still exists but is now acked-as-cancel
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't1' }).length).toBe(0);
});

test('re-arming --after with the same (from,to,task) REPLACES the prior pending — no duplicate watchdog', async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 't2', 'arm 1']);
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 't2', 'arm 2']);
  const pend = pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't2' });
  expect(pend.length).toBe(1); // only the latest survives
  expect(pend[0]?.body).toBe('arm 2');
  // the ledger holds both; the first was tombstoned
  expect(loadLedger(m).filter((x) => x?.task === 't2').length).toBe(2);
});

test("cancel is scoped to the sender — one router can't cancel another's watchdog", async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'shared', 'mine']);
  const { out } = await runMsg(cfgPath, 'router2', ['cancel', 'shared']); // different sender
  expect(out).toContain('nothing of yours is waiting');
  expect(out).toContain('only their own sender can retract them');
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 'shared' }).length).toBe(1); // untouched
});

test('cancel with no task → usage, exit 1', async () => {
  const { cfgPath } = setup();
  const { code, out } = await runMsg(cfgPath, 'router', ['cancel']);
  expect(code).toBe(1);
  expect(out).toContain('usage: ccmux msg cancel');
});

test('dedup replace only fires with a --task — same target, no task, keeps both pending', async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', 'no-task a']);
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', 'no-task b']);
  const worker = loadSessions(m).find((session) => session.name === 'worker');
  if (worker === undefined) throw new Error('worker fixture missing');
  expect(
    pendingConditional(loadLedger(m), loadAckedIds(m), { to: managedPeer(m.rcPrefix, worker) })
      .length,
  ).toBe(2);
});

test('--after + --interrupt prints the trap note but still sends', async () => {
  const { cfgPath, m } = setup();
  const { code, out } = await runMsg(cfgPath, 'router', [
    'worker',
    '--after',
    '600',
    '--interrupt',
    '--task',
    't3',
    'both',
  ]);
  expect(code).toBe(0);
  expect(out).toContain('--after with --interrupt');
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't3' }).length).toBe(1);
});

test('stdin body: echo … | ccmux msg <to> reads the piped text', async () => {
  const { cfgPath, m } = setup();
  const { code } = await runMsg(cfgPath, 'router', ['worker'], 'piped body here');
  expect(code).toBe(0);
  expect(loadLedger(m).at(-1)?.body).toBe('piped body here');
});

test('cancel names the immediate mail it could not withdraw, so its zero is not read as "nothing waiting"', async () => {
  const { cfgPath, m } = setup();
  // `--interrupt` is what makes a letter immediate; ordinary mail waits for a turn boundary and is
  // therefore conditional, which cancel does withdraw.
  await runMsg(cfgPath, 'router', [
    'worker',
    '--interrupt',
    '--task',
    't4',
    'already overtaken by events',
  ]);
  const { code, out } = await runMsg(cfgPath, 'router', ['cancel', 't4']);
  expect(code).toBe(0);
  // Nothing conditional to tombstone — and a bare zero here reads as an empty queue while the
  // letter is still on its way, which is exactly the conclusion a sender acts on.
  expect(out).toContain('nothing to cancel');
  expect(out).toContain("1 immediate message(s) for 't4' are still on their way");
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 't4' }).length).toBe(0);
});

test('cancel says it cannot reach mail that went to another machine, instead of a bare zero', async () => {
  const { cfgPath, m } = setup();
  const router = loadSessions(m).find((row) => row.name === 'router');
  if (router === undefined) throw new Error('fixture lost its sender');
  // A cross-machine letter lives in the RECIPIENT machine's ledger; here only the outbox record of
  // having sent it exists — which is exactly why cancel finds nothing to tombstone.
  const envelope = buildEnvelope(
    managedPeer(m.rcPrefix, router),
    { ...managedPeer(m.rcPrefix, router), machine: 'host-b', session: 'worker' },
    'sent across the fleet',
    { task: 't5', defer: true, onBehalfOf: null, notBefore: null },
  );
  writeFileSync(
    outboxPath(m),
    `${JSON.stringify({ kind: 'msg', envelope, result: { ok: true, detail: '' } })}\n`,
  );
  const { out } = await runMsg(cfgPath, 'router', ['cancel', 't5']);
  // And the name is NOT reported as unknown: the outbox knows it. Saying "check the name" one line
  // above "it went to another machine" sent a reader hunting a typo that was not there.
  expect(out).not.toContain("no task 't5'");
  expect(out).toContain('nothing to cancel');
  expect(out).toContain("1 message(s) for 't5' went to another machine");
});

// A named session outlives its own lives. `ccmux renew`, a restart, a fresh conversation — the
// address `<machine>:<session>` stays, the conversation uuid does not. Matching a sender by that
// uuid meant a letter could be retracted only until its sender next restarted, and after that by
// nobody at all: the instance that sent it was gone, and the same session's new life was a stranger
// to its own outstanding mail. Measured on a live machine: a letter four days old, its sender still
// running under the same name, `cancelled 0`.

function reincarnate(m: ReturnType<typeof setup>['m'], name: string, extra: object = {}): void {
  const rows = loadSessions(m).map((session) =>
    session.name === name ? { ...session, uuid: randomUUID(), ...extra } : session,
  );
  writeFileSync(sessionsPath(m), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  for (const session of loadSessions(m)) rotateChatCredential(m, session);
}

test('a letter outlives the life that sent it, and its session can still retract it', async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'outlives', 'watchdog']);
  const sent = loadLedger(m).at(-1);
  expect(sent?.from.kind === 'managed' && sent.from.session).toBe('router');

  reincarnate(m, 'router');
  const sender = loadSessions(m).find((row) => row.name === 'router');
  // The premise, asserted rather than assumed: this really is a different instance of one session.
  expect(sender?.uuid).not.toBe(sent?.from.kind === 'managed' ? sent.from.threadId : undefined);

  const result = await runMsg(cfgPath, 'router', ['cancel', 'outlives']);
  expect(result.out).toContain('cancelled 1 undelivered message(s)');
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 'outlives' })).toEqual([]);
});

test('a name taken over by another runtime does not inherit the previous owner’s mail', async () => {
  // The other side of loosening the key. A freed name can be taken by a different provider, and
  // letting the new owner retract the old one's letters would be the same defect pointing the other
  // way — so the runtime stays part of who the sender is.
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'handover', 'watchdog']);
  reincarnate(m, 'router', { agent: 'codex' });
  const result = await runMsg(cfgPath, 'router', ['cancel', 'handover']);
  expect(result.out).toContain('belong to');
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { task: 'handover' })).toHaveLength(1);
});

test('the three ways nothing was cancelled are told apart, because each needs a different move', async () => {
  const { cfgPath } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'theirs', 'watchdog']);

  // Someone else's letter: naming the sender is what stops the reader concluding the queue is stuck.
  const foreign = await runMsg(cfgPath, 'router2', ['cancel', 'theirs']);
  expect(foreign.out).toContain('nothing of yours is waiting');
  expect(foreign.out).toContain('router');

  // A task this ledger never carried — almost always a typo, and the one case where retrying the
  // same command verbatim is pointless.
  const unknown = await runMsg(cfgPath, 'router', ['cancel', 'theris']);
  expect(unknown.out).toContain("no task 'theris'");

  // Nothing left to retract: the letters under that task are already resolved.
  await runMsg(cfgPath, 'router', ['cancel', 'theirs']);
  const again = await runMsg(cfgPath, 'router', ['cancel', 'theirs']);
  expect(again.out).toContain('has been delivered or already retracted');
  expect(again.out).not.toContain('nothing of yours is waiting');
});

test('the queue can be read, and each letter carries how long it has waited', async () => {
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'visible', 'watchdog']);
  const older = loadLedger(m).at(-1);
  expect(older).not.toBeNull();

  const listed = await runMsg(cfgPath, 'router2', ['pending']);
  expect(listed.out).toContain('visible');
  expect(listed.out).toContain('test:worker');
  expect(listed.out).toMatch(/\b\d+[smhd]/); // an age, not a timestamp nobody subtracts by hand
  expect(listed.out).toContain('sent by another session');

  const filtered = await runMsg(cfgPath, 'router', ['pending', 'nothing-like-this']);
  expect(filtered.out).toContain("nothing is waiting for task 'nothing-like-this'");
});

test('mail the owner was already sent is not shown as waiting', async () => {
  // The owner has no pane, so no delivery cursor ever advances for them: their notices are consumed
  // by the Telegram mirror, which keeps its own index. Judged by the pane cursor instead, every
  // notice ever sent to the owner reads as still queued — eleven days of already-mirrored messages
  // presented as a stuck queue, which is the same false reading this command exists to end.
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['owner', '--task', 'mirrored', 'a notice']);
  const before = await runMsg(cfgPath, 'router', ['pending', 'mirrored']);
  expect(before.out).toContain('a notice');

  await saveCursors(m, { ...loadCursors(m), telegram: loadLedger(m).length });
  const after = await runMsg(cfgPath, 'router', ['pending', 'mirrored']);
  expect(after.out).toContain("nothing is waiting for task 'mirrored'");
});

test('mail to a session that was removed is not waiting — and is not silently dropped either', async () => {
  // Seventeen letters were found "waiting" on a live machine, aged seven to twelve days, every one
  // addressed to a session that had since been removed; thirty-six more on another machine. They
  // are not outstanding: delivery walks the live sessions, so nobody will ever pick them up, and
  // counting them said a colleague was owed an answer no one could give.
  //
  // The first attempt at this wrote cancel tombstones and was WRONG, which the live queue showed at
  // once: thirteen of the seventeen were immediate mail, and immediate mail is judged by the
  // delivery cursor and never consults the ack log — so the count did not move. Hence both kinds
  // below; a test that took only the deferred path is what let the mistake through.
  const { cfgPath, m } = setup();
  await runMsg(cfgPath, 'router', ['worker', '--after', '600', '--task', 'deferred-to-dead', 'a']);
  await runMsg(cfgPath, 'router', ['worker', '--interrupt', '--task', 'immediate-to-dead', 'b']);
  await runMsg(cfgPath, 'router', ['router2', '--after', '600', '--task', 'to-the-living', 'c']);
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), {})).toHaveLength(2);

  // The recipient leaves. Nothing about the letters changes; the ledger keeps every one of them.
  const rows = loadSessions(m).filter((session) => session.name !== 'worker');
  writeFileSync(sessionsPath(m), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const listed = await runMsg(cfgPath, 'router2', ['pending']);
  expect(listed.out).not.toContain('deferred-to-dead');
  expect(listed.out).not.toContain('immediate-to-dead');
  // Both kinds, counted — the half the first attempt missed is exactly the immediate one.
  expect(listed.out).toContain('2 letter(s) can never be delivered');
  // A live recipient is untouched: a cleanup that swallowed real mail would be worse than the lie.
  expect(listed.out).toContain('to-the-living');

  const live = deliverableTargets(m);
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), { live })).toHaveLength(1);
  expect(pendingImmediate(loadLedger(m), loadCursors(m), { live })).toHaveLength(0);
  // And nothing was erased: without the filter the record is still there to be read.
  expect(pendingConditional(loadLedger(m), loadAckedIds(m), {})).toHaveLength(2);
});
