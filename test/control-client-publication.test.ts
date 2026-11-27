import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CLIENT_NAME,
  type ClientArchive,
  NPM_REGISTRY,
} from '../scripts/control-client-archive.ts';
import {
  publishClient,
  registryHasClient,
  verifyClientProvenance,
} from '../scripts/publish-control-client.ts';

const bytes = new TextEncoder().encode('sealed SDK');
const candidate: ClientArchive = {
  bytes,
  path: 'client.tgz',
  manifest: {
    name: CLIENT_NAME,
    version: '1.2.3',
    type: 'module',
    repository: { url: 'git+https://github.com/max-listov/stitchmux.git' },
    publishConfig: { access: 'public', registry: NPM_REGISTRY },
  },
  sha256: createHash('sha256').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
};
const tarball = `${NPM_REGISTRY}/${CLIENT_NAME}/-/stitchmux-client-1.2.3.tgz`;
const meta = {
  name: CLIENT_NAME,
  version: candidate.manifest.version,
  dist: { tarball, integrity: candidate.integrity },
};
const from =
  (metadata: Response, archive = new Response(candidate.bytes)) =>
  async (url: string | URL | Request) =>
    String(url) === tarball ? archive : metadata;

test('the public registry has the candidate only if identity, integrity and downloaded bytes match', async () => {
  expect(await registryHasClient(candidate, from(Response.json(meta)))).toBe(true);
  expect(await registryHasClient(candidate, from(new Response(null, { status: 404 })))).toBe(false);
  await expect(
    registryHasClient(candidate, from(new Response(null, { status: 503 }))),
  ).rejects.toThrow('503');
  await expect(
    registryHasClient(candidate, from(Response.json({ ...meta, version: '1.2.4' }))),
  ).rejects.toThrow('identity');
  await expect(
    registryHasClient(
      candidate,
      from(
        Response.json({
          ...meta,
          dist: { ...meta.dist, tarball: 'https://example.org/client.tgz' },
        }),
      ),
    ),
  ).rejects.toThrow('identity');
  await expect(
    registryHasClient(
      candidate,
      from(Response.json({ ...meta, dist: { ...meta.dist, integrity: 'wrong' } })),
    ),
  ).rejects.toThrow('integrity differs');
  await expect(
    registryHasClient(candidate, from(Response.json(meta), new Response('wrong'))),
  ).rejects.toThrow('archive differs');
});

test('a rerun accepts the exact existing version and reconciles a lost publish response', async () => {
  let publishes = 0;
  const write = async () => {
    publishes++;
    return 1;
  };
  const noDelay = async () => {};
  await publishClient(candidate, async () => true, write, noDelay);
  expect(publishes).toBe(0);
  let reads = 0;
  await publishClient(candidate, async () => ++reads > 2, write, noDelay);
  expect(publishes).toBe(1);
  await expect(publishClient(candidate, async () => false, write, noDelay)).rejects.toThrow(
    'npm exit 1',
  );
  await expect(
    publishClient(
      candidate,
      async () => {
        throw new Error('archive differs');
      },
      write,
      noDelay,
    ),
  ).rejects.toThrow('archive differs');
  expect(publishes).toBe(2);
});

test('provenance must bind the package bytes, tag, commit and CI workflow', async () => {
  const commit = 'a'.repeat(40);
  const repository = 'https://github.com/max-listov/stitchmux';
  const ref = 'refs/tags/v1.2.3';
  const predicateType = 'https://slsa.dev/provenance/v1';
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType,
    subject: [
      {
        name: 'pkg:npm/%40stitchmux/client@1.2.3',
        digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository, ref, path: '.github/workflows/ci.yml' } },
        resolvedDependencies: [{ uri: `git+${repository}@${ref}`, digest: { gitCommit: commit } }],
      },
    },
  };
  const read = async () =>
    Response.json({
      attestations: [
        {
          predicateType,
          bundle: {
            dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
          },
        },
      ],
    });
  await verifyClientProvenance(candidate, commit, read);
  await expect(verifyClientProvenance(candidate, 'b'.repeat(40), read)).rejects.toThrow('differs');
  await expect(
    verifyClientProvenance({ ...candidate, bytes: new Uint8Array([0]) }, commit, read),
  ).rejects.toThrow('differs');
  statement.predicate.buildDefinition.externalParameters.workflow.path =
    '.github/workflows/other.yml';
  await expect(verifyClientProvenance(candidate, commit, read)).rejects.toThrow('differs');
});
