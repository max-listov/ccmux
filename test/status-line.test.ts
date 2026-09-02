import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRate } from '../src/agent/sessionStatus.ts';
import {
  countRender,
  extractMetrics,
  minimalStatusline,
  originalCommand,
  RENDER_WINDOW_MS,
} from '../src/commands/statusLine.ts';

const L = (o: unknown): string => JSON.stringify(o);

test("extractMetrics reads Claude's OWN context fields (no regex over rendered text)", () => {
  const m = extractMetrics(
    L({
      model: { display_name: 'Opus 5' },
      context_window: { used_percentage: 12, context_window_size: 1_000_000 },
      cost: { total_cost_usd: 1.24 },
    }),
    7,
  );
  expect(m).toEqual({
    ts: 7,
    pct: 12,
    contextSizeTokens: 1_000_000,
    model: 'Opus 5',
    costUsd: 1.24,
    renders: 1,
    rendersSince: 7,
  });
});

test('extractMetrics tolerates trivial/missing usage — null pct, never invented', () => {
  const m = extractMetrics(
    L({ model: { id: 'claude-opus-5' }, context_window: { context_window_size: 1_000_000 } }),
    7,
  );
  expect(m).toEqual({
    ts: 7,
    pct: null,
    contextSizeTokens: 1_000_000,
    model: 'claude-opus-5',
    costUsd: null,
    renders: 1,
    rendersSince: 7,
  });
  expect(extractMetrics('garbage', 7)).toBeNull();
});

test("originalCommand resolves project → user precedence (so a project statusline isn't dropped)", () => {
  const home = mkdtempSync(join(tmpdir(), 'sl-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    L({ statusLine: { type: 'command', command: 'USER_SL' } }),
  );
  const proj = mkdtempSync(join(tmpdir(), 'sl-proj-'));
  expect(originalCommand(proj, home)).toBe('USER_SL'); // no project statusline → falls to user
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(
    join(proj, '.claude', 'settings.json'),
    L({ statusLine: { type: 'command', command: 'PROJECT_SL' } }),
  );
  expect(originalCommand(proj, home)).toBe('PROJECT_SL'); // project overrides user (the C2 fix)
});

test('originalCommand: project settings.local.json overrides settings.json (Claude precedence)', () => {
  const home = mkdtempSync(join(tmpdir(), 'sl-h3-'));
  const proj = mkdtempSync(join(tmpdir(), 'sl-p3-'));
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'settings.json'), L({ statusLine: { command: 'BASE' } }));
  writeFileSync(
    join(proj, '.claude', 'settings.local.json'),
    L({ statusLine: { command: 'LOCAL' } }),
  );
  expect(originalCommand(proj, home)).toBe('LOCAL');
});

test("originalCommand skips our OWN injected command but keeps a user script containing 'status-line'", () => {
  const home = mkdtempSync(join(tmpdir(), 'sl-h2-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    L({ statusLine: { command: 'ccmux status-line' } }),
  );
  expect(originalCommand(home, home)).toBeNull(); // our own standalone `status-line` subcommand → skipped
  // a real user statusline whose path merely CONTAINS the substring must NOT be skipped (guard is word-precise)
  const u = mkdtempSync(join(tmpdir(), 'sl-u-'));
  mkdirSync(join(u, '.claude'), { recursive: true });
  writeFileSync(
    join(u, '.claude', 'settings.json'),
    L({ statusLine: { command: '~/bin/status-line-pretty.sh' } }),
  );
  expect(originalCommand(u, u)).toBe('~/bin/status-line-pretty.sh');
  const empty = mkdtempSync(join(tmpdir(), 'sl-empty-'));
  expect(originalCommand(empty, empty)).toBeNull();
});

test('minimalStatusline: a useful default (model + context%) when the user has no statusline — never a blank bar', () => {
  expect(
    minimalStatusline({
      ts: 1,
      pct: 12,
      contextSizeTokens: 1_000_000,
      model: 'Opus 5',
      costUsd: 0,
      renders: 1,
      rendersSince: 7,
    }),
  ).toBe('Opus 5 · 120k/1.0M 12%');
  expect(
    minimalStatusline({
      ts: 1,
      pct: null,
      contextSizeTokens: null,
      model: 'Opus 5',
      costUsd: null,
      renders: 1,
      rendersSince: 7,
    }),
  ).toBe('Opus 5');
  expect(
    minimalStatusline({
      ts: 1,
      pct: null,
      contextSizeTokens: null,
      model: null,
      costUsd: null,
      renders: 1,
      rendersSince: 1,
    }),
  ).toBe('');
});

const metrics = (ts: number, renders = 1, rendersSince = ts) => ({
  ts,
  pct: null,
  contextSizeTokens: null,
  model: null,
  costUsd: null,
  renders,
  rendersSince,
});

test('the render count carries forward and keeps the window it counts', () => {
  const first = countRender(null, metrics(1_000));
  expect(first.renders).toBe(1);
  const second = countRender(first, metrics(2_000));
  expect(second.renders).toBe(2);
  // The window must not move with the count: a window that restarted at every render would divide
  // by the gap between the last two and report a rate that is always about one event.
  expect(second.rendersSince).toBe(first.rendersSince);
});

test('a count older than its window starts a new one instead of averaging two days away', () => {
  const old = metrics(1_000, 400, 1_000);
  const next = countRender(old, metrics(1_000 + RENDER_WINDOW_MS + 1));
  expect(next.renders).toBe(1);
  // From the previous write, not from now: the session was rendering until then, and starting the
  // window at `now` would claim it had been idle for the whole gap.
  expect(next.rendersSince).toBe(old.ts);
});

test('a record written before the counter existed reads as unmeasured, not as zero', () => {
  // The schema defaults both fields, so an old file parses — and it must not be counted, or the
  // fleet rate would be diluted by sessions that never reported one.
  expect(renderRate([metrics(1_000, 0, 0)], 61_000)).toBeNull();
  expect(renderRate([null, null], 61_000)).toBeNull();
});

test('the rate is per minute over each window, and a quiet session decays', () => {
  // Sixty renders over the minute that just ended.
  expect(renderRate([metrics(60_000, 60, 0)], 60_000)?.perMinute).toBeCloseTo(60, 5);
  // The same record read a minute later: nothing new arrived, so the same sixty now spread over two
  // minutes. Closing the window at the last write instead of at `now` would still claim sixty.
  expect(renderRate([metrics(60_000, 60, 0)], 120_000)?.perMinute).toBeCloseTo(30, 5);
  const both = renderRate([metrics(60_000, 60, 0), metrics(60_000, 30, 0)], 60_000);
  expect(both).toEqual({ perMinute: 90, sessions: 2 });
});
