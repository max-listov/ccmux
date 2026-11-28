import { expect, test } from 'bun:test';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dir, '..');

/**
 * The package root as a browser gets it: built for the browser with its dependencies, evaluated in a
 * context that has a browser's globals and nothing of Node — no `process`, no `require`, no
 * `SharedArrayBuffer` (a page without cross-origin isolation). A browser consumer of the schemas
 * failed to start on 0.96.1, whose root loaded the socket transport and the machine's paths.
 */
async function loadInBrowser(entry: string): Promise<Record<string, unknown>> {
  const out = await Bun.build({
    entrypoints: [join(root, entry)],
    target: 'browser',
    format: 'esm',
  });
  if (!out.success) throw new Error(out.logs.map(String).join('\n'));
  const code = await (out.outputs[0] as Bun.BuildArtifact).text();
  const block = /export\s*\{([^}]*)\};?\s*$/.exec(code);
  if (block?.index === undefined) throw new Error('the browser build has no export list');
  const names = (block[1] as string)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const [local, exported] = name.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}: ${local}`;
    });
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    Headers,
    Request,
    Response,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
    crypto: globalThis.crypto,
  });
  vm.runInContext(
    `${code.slice(0, block.index)}globalThis.__exports = {${names.join(', ')}};`,
    context,
  );
  return (context as { __exports: Record<string, unknown> }).__exports;
}

test('the package root loads in a browser: no process, SharedArrayBuffer or Node module at load', async () => {
  const client = await loadInBrowser('src/client.ts');
  const usage = client.UsageReadSchema as { safeParse: (value: unknown) => { success: boolean } };
  expect(usage.safeParse({ address: 'host-a:agent-a' }).success).toBe(true);
  expect(typeof client.createInjectedControlClient).toBe('function');
  expect(client.refusals).toBeDefined();
  // The client over the local socket is its own entry point.
  expect(client.createControlClient).toBeUndefined();
});
