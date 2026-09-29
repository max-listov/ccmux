import { join } from 'node:path';
import { ROUTED_PROGRAMS, type RoutedProgram } from '../src/boot/routedPrograms.ts';

/**
 * Each routed program (`src/boot/routedPrograms.ts`), compiled on its own so a verb that runs
 * constantly does not parse the whole CLI bundle. Same source as its verb — never a second one.
 */
export async function buildRoutedProgram(
  program: RoutedProgram,
  directory: string,
): Promise<{ bytes: Uint8Array }> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '..', program.entry)],
    target: 'bun',
    minify: true,
  });
  const [artifact] = result.outputs;
  if (!result.success || !artifact)
    throw new Error(`${program.file} build failed: ${result.logs.join('\n')}`);
  const bytes = new Uint8Array(await artifact.arrayBuffer());
  if (directory !== '') await Bun.write(join(directory, program.file), bytes);
  return { bytes };
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error('usage: bun scripts/build-routed-programs.ts <output-directory>');
  for (const program of ROUTED_PROGRAMS) await buildRoutedProgram(program, directory);
}
