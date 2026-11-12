import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CorpusSearchJsonSchema } from '../src/context/corpusSearchSchema.ts';
import { SearchReportJsonSchema } from '../src/context/searchReport.ts';
import { controlContract } from '../src/control/schema/contract.ts';
import { controlEventsContract } from '../src/control/schema/eventsContract.ts';

const output = (key: keyof typeof controlContract.endpoints) =>
  z.toJSONSchema(controlContract.endpoints[key].output);

/** What each command prints with `--schema`, read off the contract itself rather than the table. */
const EXPECTED: [string[], unknown][] = [
  [
    ['whois', '--schema'],
    {
      answer: output('identity.whois'),
      list: output('identity.list'),
      event: z.toJSONSchema(controlEventsContract.endpoints.watchIdentities.stream.item),
    },
  ],
  [['fleet', '--schema'], output('fleet.list')],
  [['chat', 'log', '--schema'], output('chat.log')],
  [['msg', '--schema'], { receipt: output('letter.send'), sent: output('letter.list') }],
  // A stream on the wire, collected into the one answer the command prints.
  [
    ['search', '--schema'],
    {
      answer: z.toJSONSchema(CorpusSearchJsonSchema),
      report: z.toJSONSchema(SearchReportJsonSchema),
    },
  ],
];

test('a command describes its --json answer with the schema its operation declares', async () => {
  const bareHome = mkdtempSync(join(tmpdir(), 'ccmux-bare-home-'));
  for (const [argv, expected] of EXPECTED) {
    // No agent runtime, tmux or config on PATH or under the home directory: a schema is read off the contract, so a command
    // that needs the machine to print one fails here on every host, not only on a bare CI runner.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...argv], {
      env: { ...process.env, CCMUX_SESSION: '', PATH: '/nonexistent', HOME: bareHome },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // The command, its exit and its own words first: an unparsable answer names its cause.
    expect([argv.join(' '), code, err.slice(0, 400)]).toEqual([argv.join(' '), 0, '']);
    expect([argv.join(' '), JSON.parse(out)]).toEqual([argv.join(' '), expected]);
  }
});
