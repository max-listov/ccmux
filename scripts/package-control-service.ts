#!/usr/bin/env bun
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  CCMUX_NATIVE_STREAM_COMMAND,
  CCMUX_NATIVE_STREAM_HEARTBEAT_MS,
  CCMUX_NATIVE_STREAM_MAX_FRAME_BYTES,
  CCMUX_NATIVE_STREAM_MAX_INPUT_BYTES,
  CCMUX_NATIVE_STREAM_PROFILE,
} from '../src/control/nativeStreamContract.ts';
import { ccmuxControlServiceDescriptor } from '../src/control/serviceDescriptor.ts';
import { VERSION } from '../src/util/version.ts';

const ROOT = resolve(import.meta.dir, '..');
const PackageSchema = z
  .object({
    dependencies: z.object({ stitchkit: z.string().min(1), zod: z.string().min(1) }),
  })
  .passthrough();

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** Build a public, transport-injected consumer package; it has no socket or provider runtime. */
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
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'es2022',
      '--allowImportingTsExtensions',
      'true',
      '--skipLibCheck',
      'false',
      join(ROOT, 'src/control-service-client.ts'),
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await types.exited) !== 0) throw new Error('Control service client declarations failed');
  for (const file of await readdir(join(stage, 'types'), { recursive: true })) {
    if (!file.endsWith('.d.ts')) continue;
    const path = join(stage, 'types', file);
    const content = await readFile(path, 'utf8');
    await writeFile(
      path,
      content.replace(
        /from (["'])(\.[^"']+)\.ts\1/g,
        (_match, quote: string, name: string) => `from ${quote}${name}.js${quote}`,
      ),
    );
  }

  await writeFile(
    join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name: '@ccmux/control-service-client',
        version: VERSION,
        type: 'module',
        files: ['dist', 'types', 'descriptor.json', 'native-stream.json', 'README.md'],
        exports: {
          '.': { types: './types/control-service-client.d.ts', import: './dist/index.js' },
          './descriptor.json': './descriptor.json',
          './native-stream.json': './native-stream.json',
        },
        dependencies: sourcePackage.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(stage, 'descriptor.json'),
    `${JSON.stringify(ccmuxControlServiceDescriptor, null, 2)}\n`,
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
    'Typed CCMux declared-service client and native stream profile. Inject transport delivery explicitly; the package opens no socket, starts no provider and performs no retry. Operator configuration owns executable/socket paths, credentials, grants and node bindings.\n',
  );

  const before = new Set(await readdir(destination));
  const pack = Bun.spawn(['bun', 'pm', 'pack', '--quiet', '--destination', destination], {
    cwd: stage,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const packedName = (await new Response(pack.stdout).text()).trim();
  if ((await pack.exited) !== 0) throw new Error('Control service client packing failed');
  const after = await readdir(destination);
  const created = after.find((file) => file.endsWith('.tgz') && !before.has(file));
  const artifact = join(destination, created ?? basename(packedName));
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
