import { readBoundedBody } from 'stitchkit/http';
import { z } from 'zod';
import { VERSION } from '../src/util/version.ts';
import {
  CLIENT_NAME,
  type ClientArchive,
  inspectClientArchive,
  NPM_REGISTRY,
} from './control-client-archive.ts';

const provenanceType = 'https://slsa.dev/provenance/v1';
const metadata = z.object({
  name: z.literal(CLIENT_NAME),
  version: z.string(),
  dist: z.object({ tarball: z.url(), integrity: z.string() }),
});

const attestations = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: z.object({
        dsseEnvelope: z.object({ payload: z.string() }),
      }),
    }),
  ),
});
const provenance = z.object({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  predicateType: z.literal(provenanceType),
  subject: z
    .array(z.object({ name: z.string(), digest: z.object({ sha512: z.string() }) }))
    .length(1),
  predicate: z.object({
    buildDefinition: z.object({
      externalParameters: z.object({
        workflow: z.object({ repository: z.string(), ref: z.string(), path: z.string() }),
      }),
      resolvedDependencies: z.array(
        z.object({ uri: z.string(), digest: z.object({ gitCommit: z.string() }) }),
      ),
    }),
  }),
});

/** Match npm's provenance statement to the artifact and the checkout that prepared the GitHub draft. */
export async function verifyClientProvenance(
  archive: ClientArchive,
  commit: string,
  get: (url: string, options: RequestInit) => Promise<Response> = fetch,
) {
  const version = archive.manifest.version;
  const ref = `refs/tags/v${version}`;
  const repository = 'https://github.com/max-listov/stitchmux';
  const signal = AbortSignal.timeout(30_000);
  const url = `${NPM_REGISTRY}/-/npm/v1/attestations/@stitchmux%2fclient@${version}`;
  const request = () => get(url, { signal, redirect: 'error' });
  let response = await request();
  for (let retry = 0; response.status === 404 && retry < 9; retry++) {
    await response.body?.cancel();
    await Bun.sleep(2000);
    response = await request();
  }
  if (!response.ok) throw new Error(`Cannot verify npm provenance: HTTP ${response.status}`);
  const data = await readBoundedBody(response.body, {
    maxBytes: 4 * 1024 * 1024,
    signal,
    limitError: () => new Error('Oversized npm attestation'),
  });
  const proofs = attestations
    .parse(JSON.parse(new TextDecoder().decode(data)))
    .attestations.filter((item) => item.predicateType === provenanceType);
  if (proofs.length !== 1 || !proofs[0]) throw new Error('Expected one npm provenance statement');
  const proof = provenance.parse(
    JSON.parse(Buffer.from(proofs[0].bundle.dsseEnvelope.payload, 'base64').toString('utf8')),
  );
  const build = proof.predicate.buildDefinition;
  const workflow = build.externalParameters.workflow;
  const digest = new Bun.CryptoHasher('sha512').update(archive.bytes).digest('hex');
  if (
    proof.subject[0]?.name !== `pkg:npm/%40stitchmux/client@${version}` ||
    proof.subject[0]?.digest.sha512 !== digest ||
    workflow.repository !== repository ||
    workflow.ref !== ref ||
    workflow.path !== '.github/workflows/ci.yml' ||
    !build.resolvedDependencies.some(
      (entry) => entry.uri === `git+${repository}@${ref}` && entry.digest.gitCommit === commit,
    )
  )
    throw new Error('npm provenance differs from the tagged SDK build');
}

/** Only an absent version can be published. On retry, verify the actual bytes served to a consumer. */
export async function registryHasClient(
  archive: ClientArchive,
  get: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  const id = `${CLIENT_NAME}@${archive.manifest.version}`;
  const options = { signal: AbortSignal.timeout(30_000), redirect: 'error' } as const;
  const read = async (response: Response, maxBytes: number) => {
    if (!response.ok) throw new Error(`Registry HTTP ${response.status} for ${id}`);
    return readBoundedBody(response.body, {
      signal: options.signal,
      maxBytes,
      limitError: () => new Error(`Oversized registry response for ${id}`),
    });
  };
  const response = await get(
    `${NPM_REGISTRY}/${encodeURIComponent(CLIENT_NAME)}/${archive.manifest.version}`,
    options,
  );
  if (response.status === 404) return false;
  const meta = metadata.parse(
    JSON.parse(new TextDecoder().decode(await read(response, 1024 * 1024))),
  );
  const url = new URL(meta.dist.tarball);
  if (
    meta.version !== archive.manifest.version ||
    url.origin !== NPM_REGISTRY ||
    url.username ||
    url.password
  )
    throw new Error(`Unexpected registry identity for ${id}`);
  if (meta.dist.integrity !== archive.integrity)
    throw new Error(`Registry integrity differs for ${id}`);
  const bytes = await read(await get(url.href, options), archive.bytes.byteLength);
  if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== archive.sha256)
    throw new Error(`Registry archive differs for ${id}`);
  return true;
}

export async function publishClient(
  archive: ClientArchive,
  verify = registryHasClient,
  publish = publishFromTag,
  pause: () => Promise<unknown> = () => Bun.sleep(2000),
): Promise<void> {
  if (await verify(archive)) return;
  const code = await publish(archive);
  // A publish can reach the registry before the CLI loses its response. Replicas can lag either way.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt) await pause();
    if (await verify(archive)) return;
  }
  throw new Error(`Published client could not be verified (npm exit ${code})`);
}

async function publishFromTag(archive: ClientArchive): Promise<number> {
  const ref = `refs/tags/v${archive.manifest.version}`;
  const env = process.env;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REF !== ref ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    env.GITHUB_WORKFLOW_REF !== `max-listov/stitchmux/.github/workflows/ci.yml@${ref}`
  )
    throw new Error('Publishing requires the trusted tagged CI workflow');
  if (
    new Bun.CryptoHasher('sha256').update(await Bun.file(archive.path).bytes()).digest('hex') !==
    archive.sha256
  )
    throw new Error('SDK archive changed before publish');
  return Bun.spawn(
    [
      'npm',
      'publish',
      archive.path,
      '--access',
      'public',
      '--registry',
      NPM_REGISTRY,
      '--provenance',
      '--ignore-scripts',
    ],
    { timeout: 180_000, stdout: 'inherit', stderr: 'inherit' },
  ).exited;
}

if (import.meta.main) {
  const [path, expected] = Bun.argv.slice(2);
  const commit = process.env.GITHUB_SHA;
  if (
    !path ||
    !expected ||
    !/^[0-9a-f]{64}$/.test(expected) ||
    !commit ||
    !/^[0-9a-f]{40}$/.test(commit)
  )
    throw new Error('Usage: publish-control-client.ts <tested archive> <expected sha256>');
  const archive = await inspectClientArchive(path, VERSION);
  if (archive.sha256 !== expected)
    throw new Error('Downloaded candidate differs from the tested SDK');
  await publishClient(archive);
  await verifyClientProvenance(archive, commit);
  console.log(`Verified public npm archive: ${CLIENT_NAME}@${VERSION} sha256=${expected}`);
}
