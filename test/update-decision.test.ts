import { expect, test } from 'bun:test';
import { cacheBusted, decideUpdate } from '../src/commands/update.ts';

const base = {
  force: false,
  current: '0.1.16',
  staged: null as string | null,
  release: null as string | null,
  hasReleaseUrl: true,
  bundlePresent: true,
};

// --- the landmine: --check must NEVER apply, especially a stale/older staged bundle ---

test('--check with an OLDER staged bundle reports, never applies (the 0.1.17 downgrade landmine)', () => {
  const d = decideUpdate({ ...base, check: true, staged: '0.1.12' });
  expect(d.kind).toBe('print'); // NOT apply-staged
  if (d.kind === 'print') {
    expect(d.code).toBe(0);
    expect(d.text).toMatch(/downgrade|refuse/i);
  }
});

test('--check with a NEWER staged bundle still only reports (read-only)', () => {
  const d = decideUpdate({ ...base, check: true, staged: '0.2.0' });
  expect(d.kind).toBe('print');
});

test("--check with a newer release reports 'update available', never applies", () => {
  const d = decideUpdate({ ...base, check: true, release: '0.1.17', releaseNotes: 'notes' });
  expect(d.kind).toBe('print');
  if (d.kind === 'print') expect(d.text).toMatch(/update available/i);
});

// --- staged downgrade guard on a REAL update ---

test('a real update refuses an older staged bundle (no force) — no silent downgrade', () => {
  const d = decideUpdate({ ...base, check: false, staged: '0.1.12' });
  expect(d.kind).toBe('print');
  if (d.kind === 'print') {
    expect(d.code).toBe(1);
    expect(d.text).toMatch(/refusing to downgrade/i);
  }
});

test("an unreadable staged bundle ('?') is treated as not-newer — refused without force", () => {
  const d = decideUpdate({ ...base, check: false, staged: '?' });
  expect(d.kind).toBe('print');
  if (d.kind === 'print') expect(d.code).toBe(1);
});

test('--force overrides the downgrade guard and applies the staged bundle', () => {
  expect(decideUpdate({ ...base, check: false, force: true, staged: '0.1.12' }).kind).toBe(
    'apply-staged',
  );
});

test("a NEWER staged bundle applies without force (the legit 'test locally' path)", () => {
  expect(decideUpdate({ ...base, check: false, staged: '0.2.0' }).kind).toBe('apply-staged');
});

test('an EQUAL staged bundle applies (re-test the same version)', () => {
  expect(decideUpdate({ ...base, check: false, staged: '0.1.16' }).kind).toBe('apply-staged');
});

// --- remote path ---

test('no staged + newer release + not check → apply-remote', () => {
  expect(decideUpdate({ ...base, check: false, release: '0.1.17' }).kind).toBe('apply-remote');
});

test("no staged + already latest → prints 'already on latest', code 0", () => {
  const d = decideUpdate({ ...base, check: false, release: '0.1.16' });
  expect(d.kind).toBe('print');
  if (d.kind === 'print') {
    expect(d.code).toBe(0);
    expect(d.text).toMatch(/already on latest/i);
  }
});

test('no staged + no releaseUrl → code 1 on update, code 0 on check', () => {
  const upd = decideUpdate({ ...base, check: false, hasReleaseUrl: false });
  const chk = decideUpdate({ ...base, check: true, hasReleaseUrl: false });
  expect(upd.kind === 'print' && upd.code).toBe(1);
  expect(chk.kind === 'print' && chk.code).toBe(0);
});

test('the release manifest is fetched with a unique cache key — the header alone does not work', () => {
  // Measured on a live host minutes after publishing: `cache-control: no-cache` returned the PREVIOUS
  // version while the same URL with a query string returned the new one. Every release that day first
  // reported "already on latest", and auto-update would lag the whole fleet exactly the same way.
  expect(cacheBusted('https://x/release.json', 42)).toBe('https://x/release.json?ccmux=42');
  expect(cacheBusted('https://x/release.json?a=1', 42)).toBe('https://x/release.json?a=1&ccmux=42');
});

// --- a version match is not evidence the install is intact ---

test('a missing bundle is repaired even when the running version equals the release', () => {
  const d = decideUpdate({ ...base, check: false, release: '0.1.16', bundlePresent: false });
  expect(d.kind).toBe('apply-remote');
});

test('--check reports the missing bundle without touching anything', () => {
  const d = decideUpdate({ ...base, check: true, release: '0.1.16', bundlePresent: false });
  expect(d.kind).toBe('print');
  if (d.kind === 'print') expect(d.text).toMatch(/missing/i);
});

test('an intact install on the latest version still does nothing', () => {
  const d = decideUpdate({ ...base, check: false, release: '0.1.16', bundlePresent: true });
  expect(d.kind).toBe('print');
});
