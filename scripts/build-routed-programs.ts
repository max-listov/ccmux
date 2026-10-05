import { join } from 'node:path';
import { ROUTED_PROGRAMS, type RoutedProgram } from '../src/boot/routedPrograms.ts';
import { requireUniversalNativePackaging } from './native-companion.ts';

/**
 * Each routed program (`src/boot/routedPrograms.ts`), compiled on its own so a verb that runs
 * constantly does not parse the whole CLI bundle. Same source as its verb — never a second one.
 */
export async function buildRoutedProgram(
  program: RoutedProgram,
  directory: string,
): Promise<{ bytes: Uint8Array }> {
  const native = requireUniversalNativePackaging(`app/${program.file}`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '..', program.entry)],
    target: 'bun',
    minify: true,
    naming: { entry: `app/${program.file}` },
    splitting: false,
    plugins: [native.plugin],
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact)
    throw new Error(`${program.file} build failed: ${result.logs.join('\n')}`);
  // One program, one file: a second output would be silently left out of the installation.
  if (result.outputs.length !== 1)
    throw new Error(`${program.file}: expected one artifact, got ${result.outputs.length}`);
  const bytes = new Uint8Array(await artifact.arrayBuffer());
  if (directory !== '') await Bun.write(join(directory, program.file), bytes);
  return { bytes };
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error('usage: bun scripts/build-routed-programs.ts <output-directory>');
  for (const program of ROUTED_PROGRAMS) await buildRoutedProgram(program, directory);
}
