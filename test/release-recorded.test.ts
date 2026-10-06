import { expect, test } from 'bun:test';
import { join } from 'node:path';

const script = join(import.meta.dir, '..', 'scripts', 'release.ts');

// `--tag` publishes. It must refuse unless the conductor that records the release has set the
// variable; the second case proves the refusal is that variable's and not a general failure of the
// command (a malformed version stops it later, at its own guard, and never reaches a tag).
async function tag(version: string, recorded: boolean) {
  const env = { ...process.env };
  delete env.CCMUX_RELEASE_RECORDED;
  if (recorded) env.CCMUX_RELEASE_RECORDED = '1';
  const child = Bun.spawn([process.execPath, script, '--tag', version], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, err };
}

test('a tag is refused unless the recording conductor asked for it', async () => {
  const result = await tag('not-a-version', false);
  expect(result.code).toBe(1);
  expect(result.err).toContain('refusing to tag');
});

test('with the recording conductor, the refusal is not about recording', async () => {
  const result = await tag('not-a-version', true);
  expect(result.code).toBe(1);
  expect(result.err).not.toContain('refusing to tag');
  expect(result.err).toContain("bad version 'not-a-version'");
});
