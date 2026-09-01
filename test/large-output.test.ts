import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * An answer larger than a pipe buffer, read by someone who is not in a hurry.
 *
 * Only the property is asserted — nothing is lost — never the defect it replaced. Whether a bare
 * `console.log` loses the tail depends on the platform and on what else the process loaded: it does
 * on macOS with a CLI framework in the graph, and it did not on this project's Linux runner. A test
 * that asserted the loss passed where the bug lives and failed where it does not, which is exactly
 * backwards.
 *
 * This is the shape of the defect it exists against: `ccmux transcript --json` returned exactly
 * 65536 bytes of a longer document, with exit 0 and an empty stderr, so the only way to learn the
 * answer was cut was to fail parsing it. The cause is not in the command — it is that the writer
 * ends while bytes are still queued, and whether that happens depends on the process's module
 * graph, not on the command. So the assertion is about the boundary every command writes through.
 */

const PAYLOAD = 2_000_000;

/** A reader that waits before draining, which is what makes the pipe fill up in the first place. */
async function readSlowly(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  await Bun.sleep(1_500);
  const [out] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return out;
}

test('a large answer survives a reader that is slower than the writer', async () => {
  const root = mkdtempSync(join(resolve('.'), '.large-output-'));
  try {
    const script = join(root, 'emit.ts');
    // The CLI framework is imported deliberately: loading it changes how this process writes to
    // stdout, and that is exactly the condition under which the real command lost its tail.
    writeFileSync(
      script,
      [
        `import 'stitchkit/cli';`,
        `import { printLine } from ${JSON.stringify(resolve('src/util/stdout.ts'))};`,
        `await printLine('x'.repeat(${PAYLOAD}));`,
      ].join('\n'),
    );
    const out = await readSlowly([process.execPath, script], resolve('.'));
    expect(out.length).toBe(PAYLOAD + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
