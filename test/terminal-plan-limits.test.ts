import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAccount } from '../src/agent/claude/account.ts';
import { claudeProfile } from '../src/agent/claude/profileRoot.ts';
import { fleetAccounts } from '../src/commands/accounts.ts';
import { countRender, extractMetrics, originalCommand } from '../src/commands/statusLine.ts';
import { statusLinePlanLimits } from '../src/runtime/planLimits.ts';
import { makeMachine } from './helpers.ts';

// The status line of a terminal Claude session carries the account's plan windows — but only after
// the session's first model response. Everything here is shaped by that: an absent block says
// nothing about the plan, so it neither erases what was reported nor refreshes its time.

const FIVE = { used_percentage: 73, resets_at: 1792238400 };
const SEVEN = { used_percentage: 39, resets_at: 1792497600 };
const render = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: { display_name: 'Sonnet 5.5' },
    cost: { total_cost_usd: 1.5 },
    context_window: { used_percentage: 9, context_window_size: 1_000_000 },
    ...over,
  });

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-plan-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('the windows of a render are read as reported, and a render without them has none', () => {
  const withWindows = extractMetrics(
    render({ rate_limits: { five_hour: FIVE, seven_day: SEVEN } }),
    1_000,
  );
  expect(withWindows?.rateLimits).toEqual({
    at: 1_000,
    fiveHour: { pct: 73, resetsAt: 1792238400 },
    sevenDay: { pct: 39, resetsAt: 1792497600 },
  });
  expect(extractMetrics(render(), 1_000)?.rateLimits).toBeNull();
  // One window alone is a report; an empty block or malformed windows are not.
  expect(
    extractMetrics(render({ rate_limits: { five_hour: FIVE } }), 1_000)?.rateLimits?.sevenDay,
  ).toBeNull();
  expect(extractMetrics(render({ rate_limits: {} }), 1_000)?.rateLimits).toBeNull();
  expect(
    extractMetrics(render({ rate_limits: { five_hour: { used_percentage: 'x' } } }), 1_000)
      ?.rateLimits,
  ).toBeNull();
});

test('windows survive a render that carries none, and keep the time they were reported', () => {
  const first = extractMetrics(render({ rate_limits: { five_hour: FIVE } }), 1_000);
  const later = extractMetrics(render(), 90_000);
  if (first === null || later === null) throw new Error('metrics expected');
  const carried = countRender(first, later);
  // The mutation this guards: taking the later render's time (or none) makes 73 % look current.
  expect(carried.rateLimits?.fiveHour?.pct).toBe(73);
  expect(carried.rateLimits?.at).toBe(1_000);
  expect(carried.ts).toBe(90_000);
  // A newer report replaces it.
  const newer = extractMetrics(
    render({ rate_limits: { five_hour: { used_percentage: 80, resets_at: 1792238400 } } }),
    120_000,
  );
  if (newer === null) throw new Error('metrics expected');
  expect(countRender(carried, newer).rateLimits).toMatchObject({
    at: 120_000,
    fiveHour: { pct: 80 },
  });
});

test('the projection names its windows, dates them by the render that reported them, and never invents a plan', () => {
  const report = extractMetrics(
    render({ rate_limits: { five_hour: FIVE, seven_day: SEVEN } }),
    Date.parse('2026-10-17T10:00:00.000Z'),
  )?.rateLimits;
  const limits = statusLinePlanLimits(report ?? null);
  expect(limits?.answer).toBe('known');
  expect(limits?.plan).toBeNull();
  expect(limits?.observedAt).toBe('2026-10-17T10:00:00.000Z');
  expect(limits?.windows.map((w) => [w.key, w.percent, w.windowMinutes])).toEqual([
    ['five_hour', 73, null],
    ['seven_day', 39, null],
  ]);
  expect(limits?.windows[0]?.resetsAt).toBe(new Date(1792238400 * 1000).toISOString());
  // Not measured is null, never an empty or zero answer.
  expect(statusLinePlanLimits(null)).toBeNull();
});

test('the account of a profile is its own sign-in, and a profile with none has none', () => {
  const home = tmp();
  const own = join(home, '.claude.json');
  writeFileSync(own, JSON.stringify({ oauthAccount: { emailAddress: 'agent-a@example.test' } }));
  expect(profileAccount(own)).toEqual({
    label: 'agent-a@example.test',
    organization: null,
    subscription: null,
    provider: 'firstParty',
  });
  const none = join(home, 'none.json');
  writeFileSync(none, JSON.stringify({ projects: {} }));
  expect(profileAccount(none)).toBeNull();
  expect(profileAccount(join(home, 'absent.json'))).toBeNull();
});

test('a half-written profile file does not erase the last good answer', () => {
  const file = join(tmp(), '.claude.json');
  writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'agent-a@example.test' } }));
  expect(profileAccount(file)?.label).toBe('agent-a@example.test');
  writeFileSync(file, '{"oauthAccount": {"emailAddr'); // Claude is rewriting it
  expect(profileAccount(file)?.label).toBe('agent-a@example.test');
});

test('a session on its own credentials is not attributed to the profile login', () => {
  const dir = tmp();
  const withCloud = join(dir, 'cloud.env');
  writeFileSync(withCloud, `CLAUDE_CONFIG_DIR=${dir}\nCLAUDE_CODE_USE_BEDROCK=1\n`);
  const withToken = join(dir, 'token.env');
  writeFileSync(withToken, `CLAUDE_CONFIG_DIR=${dir}\nCLAUDE_CODE_OAUTH_TOKEN=placeholder\n`);
  const empty = join(dir, 'empty.env');
  writeFileSync(
    empty,
    `CLAUDE_CONFIG_DIR=${dir}\nANTHROPIC_AUTH_TOKEN=\nCLAUDE_CODE_USE_BEDROCK=\n`,
  );
  const key = join(dir, 'key.env');
  writeFileSync(key, `CLAUDE_CONFIG_DIR=${dir}\nANTHROPIC_API_KEY=sk-placeholder\n`);
  const m = makeMachine();
  expect(claudeProfile({ dir, envFile: withCloud }, m).ownCredentials).toBe(true);
  expect(claudeProfile({ dir, envFile: withToken }, m).ownCredentials).toBe(true);
  // The profile files declare these names with empty values to switch them OFF.
  expect(claudeProfile({ dir, envFile: empty }, m).ownCredentials).toBe(false);
  // An API key is dropped at launch when the profile has a login, so the login still decides.
  expect(claudeProfile({ dir, envFile: key }, m).ownCredentials).toBe(false);
});

test('an account is labelled the same whichever of its sessions is listed first', () => {
  const machine = (sessions: unknown[]) => [{ machine: 'host-A', sessions }] as never;
  const terminal = {
    name: 'a',
    costUsd: null,
    planLimits: null,
    account: {
      label: 'agent-a@example.test',
      organization: null,
      subscription: null,
      provider: 'firstParty',
    },
  };
  const native = {
    name: 'b',
    costUsd: null,
    planLimits: null,
    account: {
      label: 'agent-a@example.test',
      organization: null,
      subscription: 'Plan X',
      provider: 'firstParty',
    },
  };
  expect(fleetAccounts(machine([terminal, native]))[0]?.subscription).toBe('Plan X');
  expect(fleetAccounts(machine([native, terminal]))[0]?.subscription).toBe('Plan X');
});

test('the user status line comes from the profile directory when the session runs under one', () => {
  const home = tmp();
  const profile = tmp();
  const cwd = tmp();
  mkdirSync(join(home, '.claude'));
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { command: 'echo default-line' } }),
  );
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ statusLine: { command: 'echo profile-line' } }),
  );
  expect(originalCommand(cwd, home, profile)).toBe('echo profile-line');
  // Without a profile the default location is the user file; with one it is not consulted at all.
  expect(originalCommand(cwd, home)).toBe('echo default-line');
});
