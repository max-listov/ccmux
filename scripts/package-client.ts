#!/usr/bin/env bun
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  STITCHMUX_NATIVE_STREAM_COMMAND,
  STITCHMUX_NATIVE_STREAM_HEARTBEAT_MS,
  STITCHMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  STITCHMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
  STITCHMUX_NATIVE_STREAM_PROFILE,
} from '../src/control/schema/nativeStreamContract.ts';
import { VERSION } from '../src/util/version.ts';
import { normalizeClientDeclarations } from './client-declarations.ts';
import { CLIENT_NAME, NPM_REGISTRY } from './control-client-archive.ts';

const ROOT = resolve(import.meta.dir, '..');
const PackageSchema = z.looseObject({
  dependencies: z.object({ zod: z.string().min(1) }),
  peerDependencies: z.object({ stitchkit: z.string().min(1) }),
});

/**
 * The package's entry points: the contract and the injected-transport client (loads in a browser),
 * the client over the local daemon's socket, and the monitoring snapshot reader.
 */
const ENTRIES = {
  index: 'src/client.ts',
  socket: 'src/client-socket.ts',
  monitoring: 'src/monitoring-reader.ts',
} as const;

/**
 * `src/util/version.ts` imports the whole root `package.json` for one field; in the published client
 * that would ship the source's scripts and dev dependencies. Only the version goes in.
 */
const versionOnly: Bun.BunPlugin = {
  name: 'version-only',
  setup(build) {
    build.onLoad({ filter: /[\\/]package\.json$/ }, () => ({
      contents: `export default ${JSON.stringify({ version: VERSION })};`,
      loader: 'js',
    }));
  },
};

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/**
 * One build of both entry points with a shared chunk, so a schema imported from `.` and from
 * `./monitoring` is the same object. `zod` and `stitchkit` are peers: callers pass and receive their
 * schemas and contracts.
 */
export async function packageClient(directory: string): Promise<{
  artifact: string;
  sha256: string;
  bytes: number;
}> {
  const destination = resolve(directory);
  const stage = join(destination, 'client-package');
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, 'dist'), { recursive: true });
  const sourcePackage = PackageSchema.parse(
    JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')),
  );
  const build = await Bun.build({
    entrypoints: Object.values(ENTRIES).map((entry) => join(ROOT, entry)),
    outdir: join(stage, 'dist'),
    root: join(ROOT, 'src'),
    target: 'bun',
    format: 'esm',
    splitting: true,
    external: ['zod', 'stitchkit', 'stitchkit/*'],
    naming: { entry: '[name].js', chunk: 'chunk-[hash].js' },
    plugins: [versionOnly],
  });
  if (!build.success) throw new Error(`Client build failed: ${build.logs.join('\n')}`);
  await rename(join(stage, 'dist', 'client.js'), join(stage, 'dist', 'index.js'));
  await rename(join(stage, 'dist', 'client-socket.js'), join(stage, 'dist', 'socket.js'));
  await rename(join(stage, 'dist', 'monitoring-reader.js'), join(stage, 'dist', 'monitoring.js'));

  const types = Bun.spawn(
    [
      join(ROOT, 'node_modules/.bin/tsc'),
      '--ignoreConfig',
      '--declaration',
      '--emitDeclarationOnly',
      '--noEmit',
      'false',
      '--outDir',
      join(stage, 'types'),
      '--rootDir',
      ROOT,
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'es2022',
      '--strict',
      '--allowImportingTsExtensions',
      '--skipLibCheck',
      'false',
      ...Object.values(ENTRIES).map((entry) => join(ROOT, entry)),
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await types.exited) !== 0) throw new Error('Client declarations failed');
  await normalizeClientDeclarations(join(stage, 'types'));
  await copyFile(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  await writeFile(
    join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name: CLIENT_NAME,
        version: VERSION,
        description:
          'The Stitchmux client: the control contract and schemas with an injected-transport client (browser-safe), a client over the local daemon socket, and monitoring snapshots.',
        license: 'MIT',
        repository: { type: 'git', url: 'git+https://github.com/max-listov/stitchmux.git' },
        publishConfig: { access: 'public', registry: NPM_REGISTRY },
        type: 'module',
        files: ['dist', 'types', 'native-stream.json', 'README.md', 'LICENSE'],
        exports: {
          '.': { types: './types/src/client.d.ts', import: './dist/index.js' },
          './socket': { types: './types/src/client-socket.d.ts', import: './dist/socket.js' },
          './monitoring': {
            types: './types/src/monitoring-reader.d.ts',
            import: './dist/monitoring.js',
          },
          './native-stream.json': './native-stream.json',
          // A descriptor projected from this package names its version as the service revision.
          './package.json': './package.json',
        },
        peerDependencies: {
          ...sourcePackage.peerDependencies,
          zod: sourcePackage.dependencies.zod,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(stage, 'native-stream.json'),
    `${JSON.stringify(
      {
        profile: STITCHMUX_NATIVE_STREAM_PROFILE,
        command: STITCHMUX_NATIVE_STREAM_COMMAND,
        protocol: 'stable-cursor-ndjson/v1',
        stdinBytes: STITCHMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
        frameBytes: STITCHMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
        heartbeatMs: STITCHMUX_NATIVE_STREAM_HEARTBEAT_MS,
      },
      null,
      2,
    )}\n`,
  );
  await copyFile(join(ROOT, 'docs/client/README.md'), join(stage, 'README.md'));

  const pack = Bun.spawn(['bun', 'pm', 'pack', '--quiet', '--destination', destination], {
    cwd: stage,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const packedName = (await new Response(pack.stdout).text()).trim();
  if ((await pack.exited) !== 0) throw new Error('Client packing failed');
  const name = `stitchmux-client-${VERSION}.tgz`;
  if (basename(packedName) !== name) throw new Error(`Unexpected client archive: ${packedName}`);
  const artifact = join(destination, name);
  const bytes = new Uint8Array(await Bun.file(artifact).arrayBuffer());
  const hash = sha256(bytes);
  await writeFile(join(destination, 'client.sha256'), `${hash}  ${basename(artifact)}\n`);
  return { artifact, sha256: hash, bytes: bytes.byteLength };
}

if (import.meta.main) {
  const destination = Bun.argv[2];
  if (!destination) throw new Error('usage: bun scripts/package-client.ts <output-directory>');
  console.log(JSON.stringify(await packageClient(destination)));
}
