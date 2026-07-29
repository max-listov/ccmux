import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_CLI = join(ROOT, "src", "cli.ts");

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
export const STUB_REACT_DEVTOOLS = "export default { initialize() {}, connectToDevTools() {} };";

/** Build the single-file prod bundle. The ONE build path — the release ceremony, stage, CI assets,
 *  and the self-contained guard test all go through here, so what the test checks is exactly what
 *  ships. Returns false (and logs) on failure. */
export async function buildBundle(outfile: string): Promise<boolean> {
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [SRC_CLI],
    target: "bun",
    plugins: [
      {
        name: "stub-react-devtools",
        setup(build) {
          build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub-rdt" }));
          build.onLoad({ filter: /.*/, namespace: "stub-rdt" }, () => ({ contents: STUB_REACT_DEVTOOLS, loader: "js" }));
        },
      },
    ],
  });
  if (!result.success) {
    for (const l of result.logs) console.error(l);
    return false;
  }
  const [artifact] = result.outputs;
  if (artifact === undefined) {
    console.error("bundle: build produced no output artifact");
    return false;
  }
  await Bun.write(outfile, artifact);
  return true;
}
