import { join } from 'node:path';

/** Self-contained ESM library asset for resident consumers, never a CLI executable. */
export async function buildMonitoringReader(directory: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/monitoring-reader.ts')],
    target: 'bun',
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact)
    throw new Error(`monitoring reader build failed: ${result.logs.join('\n')}`);
  const bytes = await artifact.arrayBuffer();
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  await Bun.write(join(directory, 'monitoring-reader.js'), bytes);
  await Bun.write(join(directory, 'monitoring-reader.sha256'), `${hash}  monitoring-reader.js\n`);
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory)
    throw new Error('usage: bun scripts/build-monitoring-reader.ts <output-directory>');
  await buildMonitoringReader(directory);
}
