import { join } from 'node:path';

/** The status-line tee, compiled on its own so the hottest command in the fleet does not parse the
 *  whole CLI bundle to print one line. Same source as the `status-line` verb — never a second one. */
export async function buildStatusLine(directory: string): Promise<{ bytes: Uint8Array }> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/commands/statusLineEntry.ts')],
    target: 'bun',
    minify: true,
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact)
    throw new Error(`status-line build failed: ${result.logs.join('\n')}`);
  const bytes = new Uint8Array(await artifact.arrayBuffer());
  if (directory !== '') await Bun.write(join(directory, 'status-line.js'), bytes);
  return { bytes };
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error('usage: bun scripts/build-status-line.ts <output-directory>');
  await buildStatusLine(directory);
}
