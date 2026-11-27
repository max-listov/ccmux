import { join } from 'node:path';

/** Both distributed forms use the resident client entry point. */
export async function bundleControlClient(external: string[] = []): Promise<ArrayBuffer> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/control-client.ts')],
    target: 'bun',
    external,
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact)
    throw new Error(`Control client build failed: ${result.logs.join('\n')}`);
  return artifact.arrayBuffer();
}

export async function buildControlClient(directory: string): Promise<void> {
  const bytes = await bundleControlClient();
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  await Bun.write(join(directory, 'control-client.js'), bytes);
  await Bun.write(join(directory, 'control-client.sha256'), `${hash}  control-client.js\n`);
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error('usage: bun scripts/build-control-client.ts <output-directory>');
  await buildControlClient(directory);
}
