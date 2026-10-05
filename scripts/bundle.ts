import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { BunPlugin } from 'bun';
import { ROUTED_PROGRAMS } from '../src/boot/routedPrograms.ts';
import { buildRoutedProgram } from './build-routed-programs.ts';
import { customBundlePlugin } from './bundle-custom.ts';
import {
  nativeCompanion,
  requireUniversalNativePackaging,
  type UniversalNativePackaging,
} from './native-companion.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_CLI = join(ROOT, 'src', 'cli.ts');

/**
 * ink pulls an optional DEV-only React DevTools client (`react-devtools-core`) via a HOISTED static
 * import in `ink/build/devtools.js`. A static ESM import can't be lazy, so the bundler hoists it to
 * the top of the single-file bundle — it resolves at module LOAD on every launch, even though ink
 * only USES it when `process.env.DEV === 'true'` (never in prod). Marked `--external`, that import
 * had to be resolved at runtime against the global bun cache / npm auto-install, so a cleared cache
 * or no network killed the daemon with `ENOENT ... react-devtools-core` — the "self-contained"
 * bundle secretly depended on the outside world at startup.
 *
 * Fix: compile an inert stub in its place. No external import survives → the shipped bundle is truly
 * self-contained (no runtime resolution, works offline / cache-cleared). Because `onResolve`
 * intercepts the specifier before any filesystem lookup, the build no longer cares where it runs
 * from (the old "build only outside the project tree" caveat is gone). The stub carries BOTH methods
 * ink calls on the default export (`initialize` + `connectToDevTools`), so even a DEV-mode run
 * wouldn't throw.
 */
export const STUB_REACT_DEVTOOLS = 'export default { initialize() {}, connectToDevTools() {} };';

/**
 * Carry the compiled routed programs inside the bundle.
 *
 * Each could have been a release asset, and that is one more thing to download, verify, version and
 * be missing. They travel in the bundle instead, are laid down beside it on the same convergence
 * that writes the shim, and are compiled from the SAME source as their verbs — so there is one
 * implementation, and a build cannot ship two that disagree.
 */
async function routedProgramsPlugin(): Promise<BunPlugin> {
  const artifacts: Record<string, { data: string; sha256: string }> = {};
  for (const program of ROUTED_PROGRAMS) {
    const { bytes } = await buildRoutedProgram(program, '');
    artifacts[program.file] = {
      data: gzipSync(bytes, { level: 9 }).toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return {
    name: 'packaged-routed-programs',
    setup(build) {
      build.onResolve({ filter: /(^|\/)routedArtifacts\.ts$/ }, () => ({
        path: 'routed-artifacts',
        namespace: 'packaged-routed-programs',
      }));
      build.onLoad({ filter: /.*/, namespace: 'packaged-routed-programs' }, () => ({
        loader: 'ts',
        contents: `export const ROUTED_ARTIFACTS = ${JSON.stringify(artifacts)};`,
      }));
    },
  };
}

/**
 * Carry stitchkit's Darwin native backend inside the bundle. Its loader looks beside the running
 * code, and an installed bundle has no `node_modules`, so the daemon lays the backend down at
 * `native/` beside the bundle's directory (see `src/boot/nativeBackendInstall.ts`).
 */
function nativeBackendPlugin(packaging: UniversalNativePackaging): BunPlugin {
  // The digest the daemon checks on install is the one Stitchkit published for these bytes.
  const packaged = (architecture: 'arm64' | 'x64') => {
    const { bytes, sha256 } = nativeCompanion(packaging, architecture);
    return { data: gzipSync(bytes, { level: 9 }).toString('base64'), sha256 };
  };
  const artifact = {
    'darwin-arm64': packaged('arm64'),
    'darwin-x64': packaged('x64'),
  };
  return {
    name: 'packaged-native-backend',
    setup(build) {
      build.onResolve({ filter: /(^|\/)nativeBackendArtifact\.ts$/ }, () => ({
        path: 'native-backend-artifact',
        namespace: 'packaged-native-backend',
      }));
      build.onLoad({ filter: /.*/, namespace: 'packaged-native-backend' }, () => ({
        loader: 'ts',
        contents: `export const NATIVE_BACKEND_ARTIFACT = ${JSON.stringify(artifact)};`,
      }));
    },
  };
}

/** Build the single-file prod bundle. The ONE build path — the release ceremony, stage, CI assets,
 *  and the self-contained guard test all go through here, so what the test checks is exactly what
 *  ships. Returns false (and logs) on failure. */
export async function buildBundle(outfile: string): Promise<boolean> {
  mkdirSync(dirname(outfile), { recursive: true });
  const native = requireUniversalNativePackaging('app/ccmux.js');
  const result = await Bun.build({
    entrypoints: [SRC_CLI],
    target: 'bun',
    naming: { entry: 'app/ccmux.js' },
    splitting: false,
    plugins: [
      native.plugin,
      await customBundlePlugin(),
      await routedProgramsPlugin(),
      nativeBackendPlugin(native),
      {
        name: 'stub-react-devtools',
        setup(build) {
          build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: 'react-devtools-core',
            namespace: 'stub-rdt',
          }));
          build.onLoad({ filter: /.*/, namespace: 'stub-rdt' }, () => ({
            contents: STUB_REACT_DEVTOOLS,
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!result.success || result.outputs.length !== 1) {
    for (const l of result.logs) console.error(l);
    if (result.outputs.length !== 1)
      console.error(`bundle: expected one artifact, got ${result.outputs.length}`);
    return false;
  }
  const [artifact] = result.outputs;
  if (artifact === undefined) {
    console.error('bundle: build produced no output artifact');
    return false;
  }
  await Bun.write(outfile, artifact);
  return true;
}
