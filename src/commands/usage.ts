import { parseArgs } from 'node:util';
import { loadMachineConfig } from '../config/machine.ts';
import { createControlClient } from '../control/client.ts';
import { controlSocket } from '../control/path.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { peersOf, runPeer } from '../fleet/transport.ts';
import { UsageListResultSchema, UsageQuerySchema } from '../usage/schema.ts';
import { printLine } from '../util/stdout.ts';

export async function cmdUsage(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        fleet: { type: 'boolean' },
        since: { type: 'string' },
        until: { type: 'string' },
        timezone: { type: 'string' },
        cursor: { type: 'string' },
        'pipeline-cursor': { type: 'string' },
        limit: { type: 'string' },
      },
    });
    if (positionals.length > 1 || (values.fleet && positionals.length))
      throw new Error('Choose one address or --fleet');
    if (values.fleet && values.cursor)
      throw new Error('A cursor belongs to one machine; continue that machine separately');
    if (values['pipeline-cursor'] && !positionals.length)
      throw new Error('A pipeline cursor requires one exact address');
    const query = UsageQuerySchema.parse({
      since: values.since,
      until: values.until,
      timezone: values.timezone,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      cursor: positionals.length ? values.cursor : undefined,
      pipelineCursor: values['pipeline-cursor'],
    });
    const address = positionals[0];
    const m = loadMachineConfig();
    if (address) {
      const index = args.indexOf(address);
      const forwarded = await forwardIfRemote(
        address,
        'usage',
        args.filter((_, i) => i !== index),
        { m },
      );
      if (forwarded.done) return forwarded.code;
    }
    const client = createControlClient({ socket: controlSocket(m) });
    try {
      if (address) {
        const result = await client['usage.read']({ address, query });
        await printLine(JSON.stringify(result));
        return result.state === 'failed'
          ? 1
          : result.source !== 'readable' ||
              result.state !== 'ready' ||
              result.self.coverage !== 'full'
            ? 2
            : 0;
      }
      const local = await client['usage.list']({
        query,
        cursor: values.cursor ?? null,
        limit: query.limit,
      });
      if (!values.fleet) {
        await printLine(JSON.stringify(local));
        return local.nextCursor ||
          local.data.some((s) => s.state !== 'ready' || s.self.coverage !== 'full')
          ? 2
          : 0;
      }
      const remoteArgs = args.filter((a) => a !== '--fleet');
      const machines = await Promise.all(
        peersOf(m).map(async (peer) => {
          const result = await runPeer(
            m,
            peer.machine,
            peer.alias,
            ['ccmux', 'usage', ...remoteArgs],
            { timeoutMs: 10_000, connectTimeoutSeconds: 3 },
          );
          if (result.transportFailed || (result.code !== 0 && result.code !== 2))
            return { machine: peer.machine, status: 'unavailable', data: null };
          try {
            const data = UsageListResultSchema.parse(JSON.parse(result.stdout));
            if (data.machine !== peer.machine) throw new Error('Machine identity mismatch');
            return { machine: peer.machine, status: 'available', data };
          } catch {
            return { machine: peer.machine, status: 'unavailable', data: null };
          }
        }),
      );
      const all = [{ machine: m.rcPrefix, status: 'available', data: local }, ...machines];
      const partial = all.some(
        (row) =>
          row.status !== 'available' ||
          row.data?.nextCursor ||
          row.data?.data.some((s) => s.self.coverage !== 'full' || s.state !== 'ready'),
      );
      await printLine(
        JSON.stringify({
          coverage: partial ? 'partial' : 'full',
          machines: all,
          total: null,
          totalReason: 'cross-session-lineage-unproven',
        }),
      );
      return partial ? 2 : 0;
    } finally {
      await client.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
