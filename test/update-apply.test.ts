import { afterAll, beforeEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliBuildManifestSchema } from 'stitchkit/cli';
import { APP_BUNDLE } from '../src/config/paths.ts';
import { releaseDocument } from '../src/release/document.ts';
import { downloadVerifyApply, type FetchedRelease, restoreBackup } from '../src/release/update.ts';
import type { MachineConfig } from '../src/types.ts';

// The real update path, through stitchkit's `applyCliUpdate`, against a signed release served over
// HTTP. Loopback is a private host, so the test lifts the SSRF boundary the way a self-hosted feed
// would, and trusts its own key the way `releaseTrustKeys` lets such a feed.
function keyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64'),
  };
}
const ours = keyPair();
const theirs = keyPair();
const trust = { keys: { 'test-key': ours.publicKey } };

const bundles = new Map<string, string>();
let bundleRequests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (req) => {
    bundleRequests++;
    const body = bundles.get(new URL(req.url).pathname);
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  },
});
afterAll(() => server.stop(true));

const m = {} as MachineConfig;
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const bundleFor = (version: string) => `console.log('ccmux ${version}');\n`;

function release(
  path: string,
  body: string,
  version: string,
  privateKey: string | null = ours.privateKey,
): FetchedRelease {
  bundles.set(path, body);
  const document = releaseDocument({
    version,
    notes: '',
    url: `http://127.0.0.1:${server.port}${path}`,
    bundle: new TextEncoder().encode(body),
    commit: 'test',
    builtAt: new Date().toISOString(),
    ...(privateKey === null ? {} : { signing: { keyId: 'test-key', privateKey } }),
  });
  return {
    version,
    notes: '',
    url: document.url as string,
    sha256: document.sha256 as string,
    manifest: CliBuildManifestSchema.parse(document),
  };
}

beforeEach(() => {
  rmSync(dirname(APP_BUNDLE), { recursive: true, force: true });
  mkdirSync(dirname(APP_BUNDLE), { recursive: true });
  writeFileSync(APP_BUNDLE, bundleFor('1.0.0'));
  bundleRequests = 0;
});

const opts = { bounce: false, allowPrivateHosts: true, trust };

test('an update installs the release, keeps the predecessor and rolls back to it', async () => {
  const next = release('/good.js', bundleFor('1.1.0'), '1.1.0');
  expect(await downloadVerifyApply(m, next, opts)).toBeNull();
  expect(readFileSync(APP_BUNDLE, 'utf8')).toBe(bundleFor('1.1.0'));
  expect(readFileSync(`${APP_BUNDLE}.bak`, 'utf8')).toBe(bundleFor('1.0.0'));
  expect(readFileSync(`${APP_BUNDLE}.bak.sha256`, 'utf8')).toBe(sha256(bundleFor('1.0.0')));

  // Installing the same release again must not overwrite the backup with the live bundle.
  expect(await downloadVerifyApply(m, next, opts)).toBeNull();
  expect(readFileSync(`${APP_BUNDLE}.bak`, 'utf8')).toBe(bundleFor('1.0.0'));

  expect(await restoreBackup(APP_BUNDLE)).toBe(true);
  expect(readFileSync(APP_BUNDLE, 'utf8')).toBe(bundleFor('1.0.0'));
});

test('a release that is not signed by a trusted key is refused before anything is fetched', async () => {
  const unsigned = release('/unsigned.js', bundleFor('1.1.0'), '1.1.0', null);
  expect(await downloadVerifyApply(m, unsigned, opts)).toContain('signature missing');
  const foreign = release('/foreign.js', bundleFor('1.1.0'), '1.1.0', theirs.privateKey);
  expect(await downloadVerifyApply(m, foreign, opts)).toContain('signature invalid');
  const legacy = { ...unsigned, manifest: null };
  expect(await downloadVerifyApply(m, legacy, opts)).toContain('not a signed build manifest');
  expect(bundleRequests).toBe(0);
  expect(readFileSync(APP_BUNDLE, 'utf8')).toBe(bundleFor('1.0.0'));
});

test('a signed manifest whose asset was swapped after signing is refused', async () => {
  const signed = release('/swapped.js', bundleFor('1.1.0'), '1.1.0');
  const manifest = signed.manifest;
  if (manifest === null) throw new Error('unreachable');
  const swapped = {
    ...signed,
    manifest: {
      ...manifest,
      assets: manifest.assets.map((a) => ({ ...a, sha256: sha256(bundleFor('6.6.6')) })),
    },
  };
  expect(await downloadVerifyApply(m, swapped, opts)).toContain('signature invalid');
  expect(bundleRequests).toBe(0);
});

test('a bundle that does not report its version never replaces the live one', async () => {
  const lying = release('/lying.js', bundleFor('6.6.6'), '1.1.0');
  const err = await downloadVerifyApply(m, lying, opts);
  expect(err).toContain('preflight failed');
  expect(readFileSync(APP_BUNDLE, 'utf8')).toBe(bundleFor('1.0.0'));
  expect(existsSync(`${APP_BUNDLE}.bak`)).toBe(false);
  // Nothing of the candidate is left beside the live bundle.
  expect(readdirSync(dirname(APP_BUNDLE)).filter((f) => !f.endsWith('.update-lock'))).toEqual([
    'ccmux.js',
  ]);
});

test('bytes that are not the published ones are refused before anything is replaced', async () => {
  const good = release('/tampered.js', bundleFor('1.1.0'), '1.1.0');
  bundles.set('/tampered.js', bundleFor('1.1.1'));
  expect(await downloadVerifyApply(m, good, opts)).not.toBeNull();
  expect(readFileSync(APP_BUNDLE, 'utf8')).toBe(bundleFor('1.0.0'));
});

test('a rollback refuses a backup that is not the one it recorded', async () => {
  expect(
    await downloadVerifyApply(m, release('/r.js', bundleFor('1.1.0'), '1.1.0'), opts),
  ).toBeNull();
  writeFileSync(`${APP_BUNDLE}.bak`, bundleFor('0.0.1'));
  await expect(restoreBackup(APP_BUNDLE)).rejects.toThrow();
  expect(readFileSync(APP_BUNDLE, 'utf8')).toBe(bundleFor('1.1.0'));
});
