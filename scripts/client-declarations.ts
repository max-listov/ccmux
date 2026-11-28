import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isStringLiteral } from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/async';

interface SpawnedProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
}

/** TypeScript 7's async API closes stdin and clears its reference without waiting for `tsgo` to
 *  exit, leaving a briefly live child that `bun test` reaps between tests. Wait for that exit. */
function spawnedServerProcess(api: API): SpawnedProcess | null {
  const client: unknown = Reflect.get(api, 'client');
  if (typeof client !== 'object' || client === null) return null;
  const proc: unknown = Reflect.get(client, 'process');
  if (
    typeof proc === 'object' &&
    proc !== null &&
    'exitCode' in proc &&
    'signalCode' in proc &&
    'once' in proc &&
    typeof proc.once === 'function'
  )
    return proc as SpawnedProcess;
  return null;
}

async function waitForExit(proc: SpawnedProcess | null): Promise<void> {
  if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(resolveExit, 2_000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

/** Resolve against the emitted declarations. A bundled module can have types without a JS file of its own. */
function esmSpecifier(file: string, specifier: string): string {
  if (!/^\.\.?\//.test(specifier) || specifier.endsWith('.json')) return specifier;
  const suffix = /(?:\.d)?\.([cm]?)[jt]sx?$/.exec(specifier);
  const stem = suffix ? specifier.slice(0, suffix.index) : specifier;
  const format = suffix?.[1] ?? '';
  const target = resolve(dirname(file), stem);
  if (existsSync(`${target}.d.${format}ts`)) return `${stem}.${format}js`;
  if (!suffix && existsSync(join(target, 'index.d.ts'))) return `${stem}/index.js`;
  throw new Error(`Unresolved declaration import in ${file}: ${specifier}`);
}

/** The declaration emitter retains source specifiers, including import("…") types.
 * Read the compiler's module references so string literal types, comments and package names stay intact. */
export async function normalizeClientDeclarations(directory: string): Promise<void> {
  const config = join(directory, 'tsconfig.json');
  await writeFile(
    config,
    JSON.stringify({
      include: ['**/*.d.ts'],
      compilerOptions: { noLib: true, noResolve: true, types: [] },
    }),
    { flag: 'wx' },
  );
  const api = new API({ cwd: directory });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    if (!project?.rootFiles.length) throw new Error('No emitted client declarations');
    for (const file of project.rootFiles) {
      const source = await project.program.getSourceFile(file);
      if (!source) throw new Error(`Cannot parse client declaration: ${file}`);
      const literals = [...source.imports, ...source.moduleAugmentations]
        .filter(isStringLiteral)
        .sort((left, right) => right.end - left.end);
      let text = source.text;
      for (const literal of literals) {
        const specifier = esmSpecifier(file, literal.text);
        if (specifier !== literal.text)
          text =
            text.slice(0, literal.getStart(source)) +
            JSON.stringify(specifier) +
            text.slice(literal.end);
      }
      if (text !== source.text) await writeFile(file, text);
    }
  } finally {
    const child = spawnedServerProcess(api);
    await api.close();
    await waitForExit(child);
    await rm(config);
  }
}
