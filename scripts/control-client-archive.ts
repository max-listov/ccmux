import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scanPublicationText } from './publication-privacy.ts';

export const CLIENT_NAME = '@stitchmux/client';
export const NPM_REGISTRY = 'https://registry.npmjs.org';
const clientFiles =
  /^package\/(?:package\.json|README\.md|LICENSE|native-stream\.json|dist\/(?:index|monitoring|chunk-[a-z0-9]+)\.js|types\/src\/(?:[\w-]+\/)*[\w-]+\.d\.ts)$/;
const clientManifest = z.looseObject({
  name: z.literal(CLIENT_NAME),
  version: z.string(),
  type: z.literal('module'),
  repository: z.object({ url: z.literal('git+https://github.com/max-listov/stitchmux.git') }),
  publishConfig: z.object({ access: z.literal('public'), registry: z.literal(NPM_REGISTRY) }),
});

export async function inspectClientArchive(path: string, version: string) {
  const bytes = await Bun.file(path).bytes();
  const files = await new Bun.Archive(bytes).files();
  const packed = files.get('package/package.json');
  if (!packed) throw new Error('Missing client package manifest');
  const manifest = clientManifest.parse(await packed.json());
  if (manifest.version !== version) throw new Error('Client archive version differs from release');
  for (const [name, file] of files) {
    if (!clientFiles.test(name)) throw new Error(`Unexpected client archive member: ${name}`);
    const body = await file.text();
    if (
      scanPublicationText(body).length ||
      /-----BEGIN [\w ]*PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{36,}\b/.test(body)
    )
      throw new Error(`Private data in client archive member: ${name}`);
  }
  return {
    path,
    manifest,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

export type ClientArchive = Awaited<ReturnType<typeof inspectClientArchive>>;
