import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountLines, fleetAccounts } from '../src/commands/accounts.ts';
import { ListItemSchema } from '../src/inventory/listSchema.ts';
import { parseClaudeUsage, parseReset } from '../src/quota/claudeUsage.ts';
import { discoverTargets } from '../src/quota/discover.ts';
import {
  type ProbeOutcome,
  type ProbeTarget,
  probeClaude,
  probeCodex,
} from '../src/quota/probe.ts';
import { backoffMs, measurementDue, refreshQuota } from '../src/quota/refresh.ts';
import { readQuotaRecord } from '../src/quota/store.ts';
import { freshestLimits, profileViews } from '../src/quota/view.ts';
import { formatPlanLimits, type PlanLimits } from '../src/runtime/planLimits.ts';
import { writeMetricsFile } from '../src/session/metricsFile.ts';
import { makeMachine, makeSession, UUID } from './helpers.ts';

// An account's quota is measured three ways — a native runtime, a terminal session's status line,
// and a probe of the vendor's own program — and they age differently. Everything here is about
// choosing between them honestly and never reading a measurement into an absence.

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-quota-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The text the client printed on a real run (the zone is the account's own).
const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 17% used · resets Oct 17 at 11:59pm (Asia/Bangkok)
Current week (all models): 51% used · resets Oct 20 at 6:59pm (Asia/Bangkok)
Current week (Fable): 0% used · resets Oct 20 at 7pm (Asia/Bangkok)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.
`;
const NOW = Date.parse('2026-10-17T12:40:00Z');

test('the windows of /usage are read with the reset in the time zone the line names', () => {
  const parsed = parseClaudeUsage(USAGE, NOW);
  if (parsed.kind !== 'windows') throw new Error('windows expected');
  expect(parsed.windows.map((w) => [w.key, w.percent, w.resetsAt, w.scope])).toEqual([
    ['five_hour', 17, '2026-10-17T16:59:00.000Z', null],
    ['seven_day', 51, '2026-10-20T11:59:00.000Z', null],
    ['model_scoped:Fable', 0, '2026-10-20T12:00:00.000Z', 'Fable'],
  ]);
});

test('a window at zero prints no reset and is not given one', () => {
  const parsed = parseClaudeUsage(
    'Current session: 0% used\nCurrent week (all models): 100% used · resets Oct 19 at 5pm (Asia/Bangkok)',
    NOW,
  );
  if (parsed.kind !== 'windows') throw new Error('windows expected');
  expect(parsed.windows[0]).toMatchObject({ key: 'five_hour', percent: 0, resetsAt: null });
  expect(parsed.windows[1]).toMatchObject({ key: 'seven_day', percent: 100 });
});

test('output that is not a usage report is an error, never an empty measurement', () => {
  expect(parseClaudeUsage('Current week: weird', NOW)).toMatchObject({ kind: 'unrecognised' });
  expect(parseClaudeUsage('something else entirely', NOW)).toMatchObject({ kind: 'unrecognised' });
  expect(parseClaudeUsage('', NOW)).toMatchObject({ kind: 'unrecognised' });
  // Whether an account is billed by the token is decided from who is signed in, never from prose:
  // text that happens to mention an API is not a usage report either.
  expect(parseClaudeUsage('You are using API usage billing', NOW)).toMatchObject({
    kind: 'unrecognised',
  });
  expect(parseClaudeUsage('Invalid API key · Please run /login', NOW)).toMatchObject({
    kind: 'unrecognised',
  });
});

test('one line the reader does not know spoils the whole report instead of being skipped', () => {
  const spoiled = `${USAGE}Current week (Opus): lots used\n`;
  expect(parseClaudeUsage(spoiled, NOW)).toMatchObject({ kind: 'unrecognised' });
});

test('the year of a reset is the one that puts it nearest to now, across New Year both ways', () => {
  const at = (text: string, now: string) => parseReset(text, 'Asia/Bangkok', Date.parse(now));
  expect(at('Jan 1 at 1am', '2026-12-30T00:00:00Z')).toBe(Date.parse('2026-12-31T18:00:00Z'));
  expect(at('Dec 31 at 11pm', '2027-01-02T00:00:00Z')).toBe(Date.parse('2026-12-31T16:00:00Z'));
  // A reset at a clock time with no date is today's, in the account's zone.
  expect(at('11:59pm', '2026-10-17T12:40:00Z')).toBe(Date.parse('2026-10-17T16:59:00Z'));
});

const limits = (observedAt: string, over: Partial<PlanLimits> = {}): PlanLimits => ({
  answer: 'known',
  plan: null,
  windows: [
    {
      key: 'five_hour',
      label: null,
      percent: 10,
      windowMinutes: null,
      resetsAt: null,
      scope: null,
    },
  ],
  observedAt,
  source: 'probe',
  error: null,
  ...over,
});

test('the freshest real measurement wins, and an absence never hides one', () => {
  const old = limits('2026-10-17T10:00:00Z', { source: 'probe' });
  const fresh = limits('2026-10-17T12:00:00Z', { source: 'statusline' });
  expect(freshestLimits(old, fresh)?.source).toBe('statusline');
  expect(freshestLimits(fresh, old)?.source).toBe('statusline');
  // A newer answer that is only "not published" is not a reading of the windows.
  const absent = limits('2026-10-17T12:30:00Z', {
    answer: 'unpublished',
    windows: [],
    source: 'native',
  });
  expect(freshestLimits(old, absent)?.source).toBe('probe');
  expect(freshestLimits(null, undefined)).toBeNull();
});

test('windows only an older source reports are kept, while they are still true', () => {
  const window = (key: string, percent: number, resetsAt: string | null = null) => ({
    key,
    label: null,
    percent,
    windowMinutes: null,
    resetsAt,
    scope: null,
  });
  // A status line knows five hours and a week; the probe, a little older, also knows a model's.
  const line = limits('2026-10-17T12:00:00Z', {
    source: 'statusline',
    windows: [window('five_hour', 30), window('seven_day', 60)],
  });
  const probed = limits('2026-10-17T11:50:00Z', {
    source: 'probe',
    windows: [window('five_hour', 10), window('seven_day', 55), window('model_scoped:Fable', 5)],
  });
  const merged = freshestLimits(line, probed);
  expect(merged?.source).toBe('statusline');
  expect(merged?.observedAt).toBe('2026-10-17T12:00:00Z');
  expect(merged?.windows.map((w) => [w.key, w.percent])).toEqual([
    ['five_hour', 30],
    ['seven_day', 60],
    ['model_scoped:Fable', 5],
  ]);
  // Too old to still be true of the account, or already reset: not carried.
  const ancient = limits('2026-10-17T10:00:00Z', {
    source: 'probe',
    windows: [window('model_scoped:Fable', 5)],
  });
  expect(freshestLimits(line, ancient)?.windows.map((w) => w.key)).toEqual([
    'five_hour',
    'seven_day',
  ]);
  const reset = limits('2026-10-17T11:55:00Z', {
    source: 'probe',
    windows: [window('model_scoped:Fable', 5, '2026-10-17T11:58:00.000Z')],
  });
  expect(freshestLimits(line, reset)?.windows.map((w) => w.key)).toEqual([
    'five_hour',
    'seven_day',
  ]);
});

test('a measurement is due when old, when a window has ended, and when there is none', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const fifteen = 15 * 60_000;
  expect(measurementDue(null, now, fifteen)).toBe(true);
  expect(measurementDue(limits('2026-10-17T11:50:00Z'), now, fifteen)).toBe(false);
  expect(measurementDue(limits('2026-10-17T11:40:00Z'), now, fifteen)).toBe(true);
  const ended = limits('2026-10-17T11:55:00Z', {
    windows: [
      {
        key: 'five_hour',
        label: null,
        percent: 90,
        windowMinutes: null,
        resetsAt: '2026-10-17T11:58:00.000Z',
        scope: null,
      },
    ],
  });
  expect(measurementDue(ended, now, fifteen)).toBe(true);
  // An answer with no windows (billed by the token) goes stale by age only: asked every pass it
  // would spawn the vendor's program once a minute for ever.
  const none = limits('2026-10-17T11:59:30Z', { answer: 'no-plan-limit', windows: [] });
  expect(measurementDue(none, now, fifteen)).toBe(false);
  expect(measurementDue({ ...none, observedAt: '2026-10-17T11:40:00Z' }, now, fifteen)).toBe(true);
});

test('a failed profile is left alone for longer each time, up to an hour', () => {
  expect(backoffMs(1)).toBe(5 * 60_000);
  expect(backoffMs(2)).toBe(10 * 60_000);
  expect(backoffMs(3)).toBe(20 * 60_000);
  expect(backoffMs(20)).toBe(60 * 60_000);
});

function home(): { root: string; login: (dir: string, email: string) => void } {
  const root = tmp();
  return {
    root,
    login(dir, email) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: email } }),
      );
    },
  };
}

test('every place an account is signed in is found, whether or not a session runs there', () => {
  const h = home();
  writeFileSync(
    join(h.root, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'agent-a@example.test' } }),
  );
  h.login(join(h.root, '.claude-3'), 'agent-c@example.test');
  // A directory without a login, a stray file and an empty Codex directory are not profiles.
  mkdirSync(join(h.root, '.claude-cache'));
  writeFileSync(join(h.root, '.claude.json.backup'), '{}');
  mkdirSync(join(h.root, '.codex'));
  writeFileSync(join(h.root, '.codex', 'auth.json'), '{}');
  mkdirSync(join(h.root, '.codex-work'));
  writeFileSync(join(h.root, '.codex-work', 'auth.json'), '{}');
  mkdirSync(join(h.root, '.codex-empty'));
  const found = discoverTargets(makeMachine(), [], { home: h.root });
  expect(found.map((t) => t.key)).toEqual([
    'claude:default',
    `claude:${join(h.root, '.claude-3')}`,
    'codex:default',
    `codex:${join(h.root, '.codex-work')}`,
  ]);
  // Without the scan only what sessions name is listed.
  expect(discoverTargets(makeMachine(), [], { home: h.root, scan: false })).toEqual([]);
});

test('sessions name their own profile, and a profile with several sessions is one target', () => {
  const h = home();
  const profile = join(h.root, 'profile-2');
  h.login(profile, 'agent-b@example.test');
  const env = join(h.root, 'p.env');
  writeFileSync(env, `CLAUDE_CONFIG_DIR=${profile}\n`);
  const sessions = [
    makeSession({ name: 'agent-A', uuid: UUID, envFile: env }),
    makeSession({ name: 'agent-B', uuid: '22222222-2222-4222-8222-222222222222', envFile: env }),
    makeSession({ name: 'agent-C', uuid: '33333333-3333-4333-8333-333333333333' }),
  ];
  const targets = discoverTargets(makeMachine(), sessions, { home: h.root, scan: false });
  expect(targets.map((t) => [t.key, t.sessions])).toEqual([
    ['claude:default', ['agent-C']],
    [`claude:${profile}`, ['agent-A', 'agent-B']],
  ]);
});

const okProbe = (label: string, observedAt: string): ProbeOutcome => ({
  ok: true,
  label,
  plan: 'max',
  provider: 'firstParty',
  limits: limits(observedAt, { plan: 'max' }),
});

/** A machine whose state directory is its own, and one session under a profile of its own. */
function fixture(name: string, quota?: Record<string, unknown>) {
  const profile = join(home().root, `.claude-${name}`);
  mkdirSync(profile, { recursive: true });
  const env = join(tmp(), 'p.env');
  writeFileSync(env, `CLAUDE_CONFIG_DIR=${profile}\n`);
  const session = makeSession({ name: `agent-${name}`, uuid: UUID, envFile: env });
  const m = makeMachine({ stateDir: tmp(), ...(quota === undefined ? {} : { quota }) });
  return { m, session, key: `claude:${profile}` };
}

test('a refresh asks only for the profile whose newest measurement is old, and records the answer', async () => {
  const { m, session, key } = fixture('one');
  let calls = 0;
  const ask = async (): Promise<ProbeOutcome> => {
    calls += 1;
    return okProbe('agent-c@example.test', new Date().toISOString());
  };
  const first = await refreshQuota(m, [session], { ask: ask as never, scan: false });
  expect(first.find((r) => r.key === key)).toMatchObject({ action: 'probed', ok: true });
  expect(readQuotaRecord(key)?.label).toBe('agent-c@example.test');
  const before = calls;
  // Fresh now: the same call asks nothing for that profile.
  const second = await refreshQuota(m, [session], { ask: ask as never, scan: false });
  expect(second.find((r) => r.key === key)).toMatchObject({ action: 'skipped', why: 'fresh' });
  expect(calls).toBe(before);
});

test('a failed probe keeps the last good answer, says why, and backs off', async () => {
  const { m, session, key } = fixture('two', { probe: 'auto', refreshMinutes: 5 });
  let calls = 0;
  const good = okProbe('agent-d@example.test', new Date(Date.now() - 20 * 60_000).toISOString());
  const failing = async (): Promise<ProbeOutcome> => {
    calls += 1;
    return calls === 1 ? good : { ok: false, error: 'claude /usage timed out' };
  };
  await refreshQuota(m, [session], { ask: failing as never, force: true, scan: false });
  expect(readQuotaRecord(key)?.error).toBeNull();
  // The good answer is 20 minutes old and the limit is 5: due, and it fails.
  const later = await refreshQuota(m, [session], { ask: failing as never, scan: false });
  expect(later.find((r) => r.key === key)).toMatchObject({ action: 'probed', ok: false });
  const record = readQuotaRecord(key);
  expect(record?.error).toBe('claude /usage timed out');
  expect(record?.failures).toBe(1);
  expect(record?.label).toBe('agent-d@example.test');
  expect(record?.limits?.windows.length).toBe(1);
  // Straight after, the failure's back-off holds the profile — no second call.
  const again = await refreshQuota(m, [session], { ask: failing as never, scan: false });
  expect(again.find((r) => r.key === key)).toMatchObject({ action: 'skipped', why: 'backing-off' });
  expect(calls).toBe(2);
});

test('probing can be switched off, and forced anyway when asked for', async () => {
  const { m, session, key } = fixture('three', { probe: 'off', refreshMinutes: 15 });
  let calls = 0;
  const ask = async (): Promise<ProbeOutcome> => {
    calls += 1;
    return okProbe('agent-e@example.test', new Date().toISOString());
  };
  const off = await refreshQuota(m, [session], { ask: ask as never, scan: false });
  expect(off.find((r) => r.key === key)).toMatchObject({ action: 'skipped', why: 'off' });
  expect(calls).toBe(0);
  await refreshQuota(m, [session], { ask: ask as never, force: true, scan: false });
  expect(calls).toBeGreaterThan(0);
});

test('a status line newer than the probe wins, and takes the plan the probe named', async () => {
  const { m, session, key } = fixture('four');
  await refreshQuota(m, [session], {
    force: true,
    scan: false,
    ask: (async () =>
      okProbe('agent-f@example.test', new Date(Date.now() - 3600_000).toISOString())) as never,
  });
  await writeMetricsFile(session.name, {
    ts: Date.now(),
    pct: null,
    contextSizeTokens: null,
    model: null,
    costUsd: null,
    renders: 1,
    rendersSince: Date.now(),
    rateLimits: { at: Date.now(), fiveHour: { pct: 64, resetsAt: null }, sevenDay: null },
  });
  const view = profileViews(m, [session]).find((v) => v.key === key);
  expect(view?.limits?.source).toBe('statusline');
  expect(view?.limits?.windows[0]?.percent).toBe(64);
  expect(view?.limits?.plan).toBe('max');
  expect(view?.account?.label).toBe('agent-f@example.test');
});

test('an account nobody has a session for is still in the answer, with where it is signed in', () => {
  const account = {
    label: 'agent-g@example.test',
    organization: null,
    subscription: null,
    provider: 'firstParty',
  };
  const view = {
    key: 'claude:default',
    provider: 'claude' as const,
    account,
    limits: limits('2026-10-17T12:00:00Z', { plan: 'max' }),
    error: null,
    attemptedAt: '2026-10-17T12:00:00.000Z',
    home: null,
    sessions: [],
    identityChanged: false,
  };
  const now = Date.parse('2026-10-17T12:05:00Z');
  const machines = [{ machine: 'host-A', sessions: [] }];
  const accounts = fleetAccounts(machines, now, [{ machine: 'host-A', view }]);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({
    id: 'firstParty:agent-g@example.test',
    plan: 'max',
    subscription: null,
    sessions: [],
    profiles: [{ machine: 'host-A', profile: 'default', sessions: 0, error: null }],
  });
  expect(accounts[0]?.limits?.source).toBe('probe');
  const lines = accountLines(machines, now, [{ machine: 'host-A', view }]).join('\n');
  expect(lines).toContain('no sessions');
  expect(lines).toContain('(via probe)');
});

test('the number says where it came from, and a probe or status line is not stale at six minutes', () => {
  const now = Date.parse('2026-10-17T12:06:00Z');
  const line = formatPlanLimits(limits('2026-10-17T12:00:00Z', { source: 'statusline' }), now);
  expect(line).toContain('(via statusline)');
  expect(line).not.toContain('measured');
  // The same age on a native runtime, which is asked every few minutes, is stale.
  expect(formatPlanLimits(limits('2026-10-17T12:00:00Z', { source: 'native' }), now)).toContain(
    'measured',
  );
});

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const TARGET: ProbeTarget = {
  provider: 'claude',
  key: 'claude:default',
  home: null,
  envFile: null,
};

test('the Claude probe reads who is signed in and the windows from the program itself', async () => {
  const claude = script(
    join(tmp(), 'claude'),
    `case "$1" in
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"agent-h@example.test","subscriptionType":"max"}' ;;
  -p) cat <<'USAGE_END'
${USAGE}
USAGE_END
  ;;
esac`,
  );
  const outcome = await probeClaude(makeMachine({ claudeBin: claude, stateDir: tmp() }), TARGET);
  if (!outcome.ok) throw new Error(outcome.error);
  expect(outcome).toMatchObject({
    label: 'agent-h@example.test',
    plan: 'max',
    provider: 'firstParty',
  });
  expect(outcome.limits.source).toBe('probe');
  expect(outcome.limits.windows.map((w) => w.key)).toEqual([
    'five_hour',
    'seven_day',
    'model_scoped:Fable',
  ]);
});

test('a profile billed by the token has no plan window, and says so without reading /usage', async () => {
  const claude = script(
    join(tmp(), 'claude'),
    `case "$1" in
  auth) echo '{"loggedIn":true,"authMethod":"api-key","apiProvider":"bedrock","email":"agent-i@example.test"}' ;;
  *) echo 'must not be asked' >&2; exit 9 ;;
esac`,
  );
  const outcome = await probeClaude(makeMachine({ claudeBin: claude, stateDir: tmp() }), TARGET);
  if (!outcome.ok) throw new Error(outcome.error);
  expect(outcome.limits.answer).toBe('no-plan-limit');
});

test('a signed-out profile and an unreadable report are failures with their own reasons', async () => {
  const bin = tmp();
  const out = script(join(bin, 'out'), `echo '{"loggedIn":false}'`);
  const m = (claudeBin: string) => makeMachine({ claudeBin, stateDir: tmp() });
  expect(await probeClaude(m(out), TARGET)).toEqual({
    ok: false,
    error: 'the profile is not signed in',
  });
  const odd = script(
    join(bin, 'odd'),
    `case "$1" in auth) echo '{"loggedIn":true,"apiProvider":"firstParty","email":"x@example.test"}' ;; *) echo 'Current week: ???' ;; esac`,
  );
  const failed = await probeClaude(m(odd), TARGET);
  expect(failed.ok).toBe(false);
  expect(failed.ok ? '' : failed.error).toContain('unrecognised /usage output');
});

test('the Codex probe talks JSON-RPC to the program and maps its windows', async () => {
  // A stand-in app-server: answers the requests the probe makes, one JSON line each.
  const server = join(tmp(), 'codex');
  writeFileSync(
    server,
    `#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  for (let nl = buffer.indexOf('\\n'); nl >= 0; nl = buffer.indexOf('\\n')) {
    const message = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (message.id === undefined) continue;
    const result =
      message.method === 'account/read'
        ? { account: { type: 'chatgpt', planType: 'pro', email: 'agent-j@example.test' } }
        : message.method === 'account/rateLimits/read'
          ? { rateLimits: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1792649803 }, secondary: null } }
          : {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }
}
`,
  );
  chmodSync(server, 0o755);
  const outcome = await probeCodex(makeMachine({ codexBin: server, stateDir: tmp() }), {
    provider: 'codex',
    key: 'codex:default',
    home: null,
    envFile: null,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  expect(outcome).toMatchObject({
    label: 'agent-j@example.test',
    plan: 'pro',
    provider: 'chatgpt',
  });
  expect(outcome.limits.windows[0]).toMatchObject({ percent: 42, windowMinutes: 10080 });
  expect(outcome.limits.source).toBe('probe');
});

// --- defects a review found in the first version of this layer, each with its own guard ---

test('a peer on an older or newer build still reads a plan window that carries a key it does not know', () => {
  // D1: a strict reader called the whole machine unreadable because one window gained a field.
  const item = ListItemSchema.shape.planLimits.parse({
    answer: 'known',
    plan: 'max',
    windows: [],
    observedAt: '2026-10-17T12:00:00.000Z',
    source: 'probe',
    error: null,
    someFutureKey: 1,
  });
  expect(item?.source).toBe('probe');
  // A record from a build before `source` existed reads as the runtime's own.
  const old = ListItemSchema.shape.planLimits.parse({
    answer: 'known',
    plan: 'max',
    windows: [],
    observedAt: '2026-10-17T12:00:00.000Z',
    error: null,
  });
  expect(old?.source).toBe('native');
});

test('the probe asks as the profile, not as whoever launched it', async () => {
  // D2: the stand-in prints the environment it was started with.
  const dir = tmp();
  const seen = join(dir, 'seen.txt');
  const claude = script(
    join(dir, 'claude'),
    `{
  echo "KEY=$ANTHROPIC_API_KEY"
  echo "TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
  echo "BEDROCK=$CLAUDE_CODE_USE_BEDROCK"
  echo "CCMUX=$CCMUX_SESSION"
  echo "PROFILE=$CLAUDE_CONFIG_DIR"
  echo "DECLARED=$DECLARED_VALUE"
} >> ${seen}
case "$1" in
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"agent-k@example.test","subscriptionType":"max"}' ;;
  -p) echo 'Current session: 1% used' ;;
esac`,
  );
  const env = join(dir, 'p.env');
  writeFileSync(
    env,
    `DECLARED_VALUE=from-file
ANTHROPIC_API_KEY=
`,
  );
  const keep = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-from-the-callers-shell';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-of-another-account';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CCMUX_SESSION = 'agent-launcher';
  process.env.CLAUDE_CONFIG_DIR = '/the/callers/profile';
  try {
    const profile = join(dir, 'profile');
    await probeClaude(makeMachine({ claudeBin: claude, stateDir: tmp() }), {
      provider: 'claude',
      key: `claude:${profile}`,
      home: profile,
      envFile: env,
    });
  } finally {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CCMUX_SESSION',
      'CLAUDE_CONFIG_DIR',
    ])
      if (keep[key] === undefined) delete process.env[key];
      else process.env[key] = keep[key];
  }
  const printed = readFileSync(seen, 'utf8');
  expect(printed).toContain('KEY=\n');
  expect(printed).not.toContain('sk-from-the-callers-shell');
  expect(printed).not.toContain('token-of-another-account');
  expect(printed).toContain('BEDROCK=\n');
  expect(printed).toContain('CCMUX=\n');
  expect(printed).toContain(`PROFILE=${join(dir, 'profile')}`);
  expect(printed).toContain('DECLARED=from-file');
});

test('a session on its own credentials does not lend the probe its environment file', () => {
  // D2, second path: the probe would otherwise run as that session's token.
  const h = home();
  const profile = join(h.root, 'profile-t');
  h.login(profile, 'agent-l@example.test');
  const own = join(h.root, 'own.env');
  writeFileSync(own, `CLAUDE_CONFIG_DIR=${profile}\nCLAUDE_CODE_OAUTH_TOKEN=tok\n`);
  const plain = join(h.root, 'plain.env');
  writeFileSync(plain, `CLAUDE_CONFIG_DIR=${profile}\n`);
  const sessions = [
    makeSession({ name: 'agent-A', uuid: UUID, envFile: own }),
    makeSession({ name: 'agent-B', uuid: '22222222-2222-4222-8222-222222222222', envFile: plain }),
  ];
  const [target] = discoverTargets(makeMachine(), sessions, { home: h.root, scan: false });
  expect(target?.envFile).toBe(plain);
});

test('a profile signed in as someone else since its record was taken is not described by that record', async () => {
  // D3: the old account's windows were shown under the old address, and no probe was due.
  const { m, session, key } = fixture('swap');
  const file = join(session.envFile ? join(session.envFile, '..') : tmp(), 'unused');
  void file;
  const profile = key.slice('claude:'.length);
  writeFileSync(
    join(profile, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'agent-a@example.test' } }),
  );
  await refreshQuota(m, [session], {
    force: true,
    scan: false,
    ask: (async () => okProbe('agent-a@example.test', new Date().toISOString())) as never,
  });
  expect(profileViews(m, [session])[0]?.identityChanged).toBe(false);
  // The profile is now signed in as B; a status line from B is fresh.
  writeFileSync(
    join(profile, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'agent-b@example.test', note: 'changed' } }),
  );
  const view = profileViews(m, [session])[0];
  expect(view?.identityChanged).toBe(true);
  expect(view?.account?.label).toBe('agent-b@example.test');
  expect(view?.limits).toBeNull();
  let asked = 0;
  await refreshQuota(m, [session], {
    scan: false,
    ask: (async () => {
      asked += 1;
      return okProbe('agent-b@example.test', new Date().toISOString());
    }) as never,
  });
  expect(asked).toBe(1);
  expect(readQuotaRecord(key)?.label).toBe('agent-b@example.test');
});

test('an account billed by the token is decided from who is signed in, and tolerates null fields', async () => {
  // D5 + D6: nulls in the identity answer, and an API key that prints a cost report, not windows.
  const apiKey = script(
    join(tmp(), 'claude'),
    `case "$1" in
  auth) echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","email":null,"subscriptionType":null}' ;;
  *) echo 'Total cost: $1.00'; exit 0 ;;
esac`,
  );
  const outcome = await probeClaude(makeMachine({ claudeBin: apiKey, stateDir: tmp() }), TARGET);
  if (!outcome.ok) throw new Error(outcome.error);
  expect(outcome.limits.answer).toBe('no-plan-limit');
  expect(outcome.label).toBeNull();
  expect(outcome.plan).toBeNull();
});

test('a blank value from the vendor is absence, and does not break the record', async () => {
  // D8: an empty string failed the store's validation and aborted the pass over every profile.
  const blank = script(
    join(tmp(), 'claude'),
    `case "$1" in
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"  ","subscriptionType":""}' ;;
  -p) echo 'Current session: 3% used' ;;
esac`,
  );
  const outcome = await probeClaude(makeMachine({ claudeBin: blank, stateDir: tmp() }), TARGET);
  if (!outcome.ok) throw new Error(outcome.error);
  expect(outcome.label).toBeNull();
  expect(outcome.plan).toBeNull();
});

test('a Codex home declared with $HOME is the one the session means', () => {
  // D7: with no HOME in scope the value became "/.codex-work".
  const h = home();
  const env = join(h.root, 'codex.env');
  writeFileSync(env, 'CODEX_HOME=$HOME/.codex-work/\n');
  const session = makeSession({ name: 'agent-C', uuid: UUID, agent: 'codex', envFile: env });
  const [target] = discoverTargets(makeMachine(), [session], { home: h.root, scan: false });
  expect(target?.key).toBe(`codex:${join(h.root, '.codex-work')}`);
  expect(target?.home).toBe(join(h.root, '.codex-work'));
});

test('a saved copy of a profile and a linked profile directory are told apart', () => {
  const h = home();
  h.login(join(h.root, '.claude-work'), 'agent-m@example.test');
  h.login(join(h.root, '.claude-work.bak'), 'agent-m@example.test');
  h.login(join(h.root, 'real-elsewhere'), 'agent-n@example.test');
  symlinkSync(join(h.root, 'real-elsewhere'), join(h.root, '.claude-linked'));
  const keys = discoverTargets(makeMachine(), [], { home: h.root }).map((t) => t.key);
  expect(keys).toContain(`claude:${join(h.root, '.claude-work')}`);
  expect(keys).toContain(`claude:${join(h.root, '.claude-linked')}`);
  expect(keys).not.toContain(`claude:${join(h.root, '.claude-work.bak')}`);
});

test('two askers for one profile make one call, and the second reads what the first learned', async () => {
  // The daemon's pass and `ccmux accounts --refresh` can run together.
  const { m, session } = fixture('race');
  let calls = 0;
  const slow = (async () => {
    calls += 1;
    await Bun.sleep(150);
    return okProbe('agent-o@example.test', new Date().toISOString());
  }) as never;
  const [a, b] = await Promise.all([
    refreshQuota(m, [session], { ask: slow, scan: false }),
    refreshQuota(m, [session], { ask: slow, scan: false }),
  ]);
  expect(calls).toBe(1);
  expect([...a, ...b].filter((r) => r.action === 'probed')).toHaveLength(1);
});

test('a stopped daemon stops the program it was waiting on', async () => {
  const slow = script(join(tmp(), 'claude'), 'sleep 30');
  const controller = new AbortController();
  const started = Date.now();
  const pending = probeClaude(
    makeMachine({ claudeBin: slow, stateDir: tmp() }),
    TARGET,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 150);
  await pending.catch(() => null);
  expect(Date.now() - started).toBeLessThan(5000);
});
