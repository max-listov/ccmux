import { loadMachineConfig } from '../config/machine.ts';
import { discoverExternal } from '../external/discover.ts';
import { ExternalInventoryJsonSchema } from '../external/sessionSchema.ts';
import { observeExternalTurns } from '../external/turnState.ts';
import type { ExternalInventoryJson, ExternalSession } from '../types.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { VERSION } from '../util/version.ts';
import { parseFlags } from './flags.ts';

export function externalInventoryJson(
  rcPrefix: string,
  sessions: ExternalSession[],
  generatedAt = new Date(),
): ExternalInventoryJson {
  return ExternalInventoryJsonSchema.parse({
    version: VERSION,
    generatedAt: generatedAt.toISOString(),
    rcPrefix,
    sessions,
  });
}

export function externalTableLines(sessions: ExternalSession[]): string[] {
  const lines = tableLines(
    ['PROVIDER', 'ORIGIN', 'STORAGE', 'WRITER', 'TURN', 'THREAD', 'DIR'],
    sessions.map((session) => [
      session.provider,
      session.origin,
      session.storage,
      `${session.writerEvidence}/${session.writerRuntime?.kind ?? '-'}`,
      session.turnState.state,
      session.threadId,
      session.dir ?? '-',
    ]),
  );
  // A column of fifty identical `unknown`s says something is wrong and nothing about what to do.
  // The cure is printed once per distinct cause, under the table rather than in it: repeating one
  // sentence on every row would bury the rows, and printing none leaves the reader to go read our
  // source to find out what `unknown` was about.
  const remedies = new Map<string, number>();
  for (const session of sessions) {
    const { reason, remedy } = session.turnState;
    if (remedy !== null)
      remedies.set(`${reason}: ${remedy}`, (remedies.get(`${reason}: ${remedy}`) ?? 0) + 1);
  }
  for (const [text, count] of remedies) lines.push(`${count} × ${text}`);
  return lines;
}

export async function cmdExternal(args: string[] = []): Promise<number> {
  const flags = parseFlags('external', args, [0, 0]);

  const machine = loadMachineConfig();
  const sessions = await observeExternalTurns(machine, discoverExternal(machine));
  if (flags.bool('json')) {
    // This projection can be much larger than a pipe buffer, so it goes through the writer that
    // waits for the pipe to drain.
    await printLine(JSON.stringify(externalInventoryJson(machine.rcPrefix, sessions)));
  } else {
    for (const line of externalTableLines(sessions)) console.log(line);
  }
  return 0;
}
