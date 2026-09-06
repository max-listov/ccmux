import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The command Claude runs on every transcript event evaluates a leaf, not the product.
 *
 * Measured on the built bundle: 127 ms of CPU a call, of which 60 ms is parsing the bundle and the
 * rest was evaluating the module graph this command reached for six numbers — `zod` costs about as
 * much to evaluate as everything else the command does, and `sessionStatus.ts` pulls the agent
 * barrel, chat types and launch stamps behind it. At 29 renders a minute across seven sessions that
 * graph was costing about 2 % of a core to write a file.
 *
 * Checked on the source rather than by the clock, for the same reason the lazy-dispatch case is: a
 * wall-clock assertion on a loaded machine fails for reasons that have nothing to do with what it
 * guards. The property is exact — an import added here the obvious way brings its whole graph back,
 * and nothing about that diff would look wrong.
 */

const source = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'statusLine.ts'),
  'utf8',
);
const leaf = readFileSync(join(import.meta.dir, '..', 'src', 'agent', 'metricsFile.ts'), 'utf8');

const imports = (text: string): string[] =>
  [...text.matchAll(/^import[^']*'([^']+)';$/gm)].map((match) => match[1] as string);

test('the status-line command imports no schema library and no agent graph', () => {
  const specifiers = imports(source);
  expect(specifiers).not.toContain('zod');
  expect(specifiers).not.toContain('../agent/sessionStatus.ts');
  // What it may reach for: node built-ins and the metrics leaf. Anything else is a new graph on the
  // hottest path this tool has, and belongs behind a deliberate measurement.
  for (const specifier of specifiers)
    expect(specifier.startsWith('node:') || specifier === '../agent/metricsFile.ts').toBe(true);
});

test('the metrics leaf stays a leaf', () => {
  const specifiers = imports(leaf);
  expect(specifiers).not.toContain('zod');
  for (const specifier of specifiers)
    expect(
      specifier.startsWith('node:') ||
        specifier === '../config/paths.ts' ||
        specifier === '../util/atomic.ts',
    ).toBe(true);
});

test('one implementation of the metrics file, re-exported rather than copied', () => {
  const status = readFileSync(
    join(import.meta.dir, '..', 'src', 'agent', 'sessionStatus.ts'),
    'utf8',
  );
  // The heavy module keeps the names its callers use, and gets them from the leaf: a second reader
  // or writer of this file would be a second authority on its format, which is how a field arrives
  // in one place and vanishes in another.
  expect(status).toContain('readMetricsFile as readMetrics');
  expect(status).not.toContain('MetricsStatusSchema');
});

/**
 * The compiled program and the verb are the same program.
 *
 * The shim routes `status-line` past the bundle to a separate file, so the two ways of running it
 * must be indistinguishable from outside: the same line on stdout, the same metrics on disk. A
 * difference would be invisible in production — the status line would simply start saying something
 * slightly else, on every session, and nothing would report it.
 *
 * What this guards is the PLUMBING, and it says so because the shape is the blind one: both sides
 * call the same function, so a change to the command itself moves them together and this test stays
 * green (verified by mutating `extractMetrics` — 4 pass). What it does catch is the entry losing the
 * command, its await, its exit code, or writing the metrics somewhere else; the command's own
 * behaviour is guarded by the tests above it.
 */
test('the status-line program answers exactly as the bundled verb does', async () => {
  // Built in a child process, the way the release builds it — and because a `Bun.build` call is the
  // first thing this process would do, which this runtime resolves unreliably until some other build
  // has warmed it. A test that fails by running first is not a statement about the code.
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-sl-equal-'));
  const build = Bun.spawn(
    [process.execPath, join(import.meta.dir, '..', 'scripts', 'build-status-line.ts'), dir],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(await build.exited).toBe(0);
  const program = join(dir, 'status-line.js');
  const payload =
    '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":42,"context_window_size":1000000},"cost":{"total_cost_usd":1.5}}';

  const run = async (argv: string[], home: string) => {
    mkdirSync(home, { recursive: true });
    const proc = Bun.spawn(argv, {
      stdin: new Response(payload),
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: join(home, 'state'),
        CCMUX_SESSION: 'sl-equal',
      },
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const metrics = join(home, 'state', 'ccmux', 'status', 'sl-equal.metrics.json');
    const written = existsSync(metrics)
      ? (JSON.parse(readFileSync(metrics, 'utf8')) as Record<string, unknown>)
      : null;
    return { out, code, written };
  };

  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  const viaBundle = await run([process.execPath, cli, 'status-line'], join(dir, 'a'));
  const viaProgram = await run([process.execPath, program], join(dir, 'b'));
  expect(viaProgram.code).toBe(viaBundle.code);
  expect(viaProgram.out).toBe(viaBundle.out);
  // `ts`/`rendersSince` are clock stamps; everything the readers use must match exactly.
  const fields = (m: Record<string, unknown> | null) =>
    m === null
      ? null
      : {
          pct: m.pct,
          contextSizeTokens: m.contextSizeTokens,
          model: m.model,
          costUsd: m.costUsd,
          renders: m.renders,
        };
  expect(fields(viaProgram.written)).toEqual(fields(viaBundle.written));
  expect(fields(viaProgram.written)).not.toBeNull();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);
