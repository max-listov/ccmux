import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { z } from 'zod';
import { CorpusSearchJsonSchema } from '../src/context/corpusSearchSchema.ts';
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
  [['search', '--schema'], z.toJSONSchema(CorpusSearchJsonSchema)],
];

test('a command describes its --json answer with the schema its operation declares', async () => {
  for (const [argv, expected] of EXPECTED) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...argv], {
      env: { ...process.env, CCMUX_SESSION: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect([argv.join(' '), code, JSON.parse(out)]).toEqual([argv.join(' '), 0, expected]);
  }
});
