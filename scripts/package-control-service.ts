#!/usr/bin/env bun
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  CCMUX_NATIVE_STREAM_COMMAND,
  CCMUX_NATIVE_STREAM_HEARTBEAT_MS,
  CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
  CCMUX_NATIVE_STREAM_PROFILE,
} from '../src/control/schema/nativeStreamContract.ts';
import { VERSION } from '../src/util/version.ts';
import { bundleControlClient } from './build-control-client.ts';
import { normalizeClientDeclarations } from './client-declarations.ts';
import { CLIENT_NAME, NPM_REGISTRY } from './control-client-archive.ts';

const ROOT = resolve(import.meta.dir, '..');
const PackageSchema = z.looseObject({
  dependencies: z.object({ zod: z.string().min(1) }),
  peerDependencies: z.object({ stitchkit: z.string().min(1) }),
});

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** The default export accepts injected transport. The resident subpath uses a local Unix socket. */
export async function packageControlServiceClient(directory: string): Promise<{
  artifact: string;
  sha256: string;
  bytes: number;
}> {
  const destination = resolve(directory);
  const stage = join(destination, 'control-service-client-package');
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, 'dist'), { recursive: true });
  const sourcePackage = PackageSchema.parse(
    JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')),
  );
  const build = await Bun.build({
    entrypoints: [join(ROOT, 'src/control-service-client.ts')],
    outdir: join(stage, 'dist'),
    target: 'browser',
    format: 'esm',
    external: ['zod', 'stitchkit', 'stitchkit/contract'],
    naming: 'index.js',
  });
  if (!build.success)
    throw new Error(`Control service client build failed: ${build.logs.join('\n')}`);
  await writeFile(
    join(stage, 'dist/control-client.js'),
    new Uint8Array(await bundleControlClient(['stitchkit', 'stitchkit/*', 'zod'])),
  );

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
      join(ROOT, 'src/control-service-client.ts'),
      join(ROOT, 'src/control-client.ts'),
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await types.exited) !== 0) throw new Error('Control service client declarations failed');
  await normalizeClientDeclarations(join(stage, 'types'));
  await copyFile(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));
  await writeFile(
    join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name: CLIENT_NAME,
        version: VERSION,
        description: 'Typed CCMux control clients for injected transports and local Unix sockets.',
        license: 'MIT',
        repository: { type: 'git', url: 'git+https://github.com/max-listov/ccmux.git' },
        publishConfig: { access: 'public', registry: NPM_REGISTRY },
        type: 'module',
        files: ['dist', 'types', 'native-stream.json', 'README.md', 'LICENSE'],
        exports: {
          '.': { types: './types/src/control-service-client.d.ts', import: './dist/index.js' },
          './control-client': {
            types: './types/src/control-client.d.ts',
            import: './dist/control-client.js',
          },
          './native-stream.json': './native-stream.json',
          // A descriptor projected from this package names its version as the service revision.
          './package.json': './package.json',
        },
        dependencies: sourcePackage.dependencies,
        peerDependencies: sourcePackage.peerDependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(stage, 'native-stream.json'),
    `${JSON.stringify(
      {
        profile: CCMUX_NATIVE_STREAM_PROFILE,
        command: CCMUX_NATIVE_STREAM_COMMAND,
        protocol: 'stable-cursor-ndjson/v1',
        stdinBytes: CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
        frameBytes: CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
        heartbeatMs: CCMUX_NATIVE_STREAM_HEARTBEAT_MS,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(stage, 'README.md'),
    'The default CCMux service client accepts an injected transport. Import the resident Unix socket client and observation schemas from `@ccmux/control-service-client/control-client`. Both entry points include ESM and TypeScript declarations.\n',
  );

  const pack = Bun.spawn(['bun', 'pm', 'pack', '--quiet', '--destination', destination], {
    cwd: stage,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const packedName = (await new Response(pack.stdout).text()).trim();
  if ((await pack.exited) !== 0) throw new Error('Control service client packing failed');
  const name = `ccmux-control-service-client-${VERSION}.tgz`;
  if (basename(packedName) !== name) throw new Error(`Unexpected client archive: ${packedName}`);
  const artifact = join(destination, name);
  const bytes = new Uint8Array(await Bun.file(artifact).arrayBuffer());
  const hash = sha256(bytes);
  await writeFile(
    join(destination, 'control-service-client.sha256'),
    `${hash}  ${basename(artifact)}\n`,
  );
  return { artifact, sha256: hash, bytes: bytes.byteLength };
}

if (import.meta.main) {
  const destination = Bun.argv[2];
  if (!destination)
    throw new Error('usage: bun scripts/package-control-service.ts <output-directory>');
  console.log(JSON.stringify(await packageControlServiceClient(destination)));
}
