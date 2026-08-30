import { join } from 'node:path';

/** Standalone native reader; no runtime, session, account or transport is created by importing it. */
export async function buildCodexRuntimeReader(directory: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/codex-runtime-reader.ts')],
    target: 'bun',
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact)
    throw new Error(`Codex runtime reader build failed: ${result.logs.join('\n')}`);
  const bytes = await artifact.arrayBuffer();
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  await Bun.write(join(directory, 'codex-runtime-reader.js'), bytes);
  await Bun.write(
    join(directory, 'codex-runtime-reader.sha256'),
    `${hash}  codex-runtime-reader.js\n`,
  );
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory)
    throw new Error('usage: bun scripts/build-codex-runtime-reader.ts <output-directory>');
  await buildCodexRuntimeReader(directory);
}
