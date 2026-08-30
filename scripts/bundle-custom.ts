import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { BunPlugin } from 'bun';
import type { CustomPackage } from '../src/agent/custom/package.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function entry(bytes: Uint8Array) {
  return { sha256: sha(bytes), data: gzipSync(bytes, { level: 9 }).toString('base64') };
}

/** Compile the owned driver once, preserving the upstream native package layout inside it.
 * The outer release remains one checksum-verified artifact, including rollback and offline use. */
export async function customBundlePlugin(): Promise<BunPlugin> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'src/agent/custom/process.ts')],
    target: 'bun',
    minify: true,
  });
  if (!result.success || result.outputs.length !== 1)
    throw new Error(`Custom bundle failed: ${result.logs.join('\n')}`);
  const module = result.outputs[0];
  if (!module) throw new Error('Custom bundle is absent');
  const arm = entry(
    await Bun.file(join(ROOT, 'node_modules/stitchkit/native/darwin-arm64.node')).bytes(),
  );
  const x64 = entry(
    await Bun.file(join(ROOT, 'node_modules/stitchkit/native/darwin-x64.node')).bytes(),
  );
  const js = entry(new Uint8Array(await module.arrayBuffer()));
  const artifact: CustomPackage = {
    digest: sha(JSON.stringify([js.sha256, arm.sha256, x64.sha256])),
    module: js,
    darwinArm64: arm,
    darwinX64: x64,
  };
  return {
    name: 'packaged-custom-runtime',
    setup(build) {
      build.onResolve({ filter: /agent\/custom\/process\.ts$/ }, () => ({
        path: 'custom-runtime',
        namespace: 'packaged-custom',
      }));
      build.onLoad({ filter: /.*/, namespace: 'packaged-custom' }, () => ({
        loader: 'ts',
        contents: `
      import { materializeCustomPackage } from ${JSON.stringify(join(ROOT, 'src/agent/custom/package.ts'))};
      const artifact = ${JSON.stringify(artifact)};
      export async function runCustomProcess(machine,session,promote) {
        const url = await materializeCustomPackage(machine,artifact);
        const driver = await import(url);
        if(typeof driver.runCustomProcess !== 'function')throw new Error('Custom runtime export is unavailable');
        await driver.runCustomProcess(machine,session,promote);
      }
    `,
      }));
    },
  };
}
