import { ExternalInventoryJsonSchema } from "../config/schema.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { discoverExternal } from "../external/discover.ts";
import { observeExternalTurns } from "../external/turnState.ts";
import type { ExternalInventoryJson, ExternalSession } from "../types.ts";
import { VERSION } from "../util/version.ts";
import { usageLine } from "./help.ts";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

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
  const lines = [
    `${pad("PROVIDER", 8)} ${pad("ORIGIN", 10)} ${pad("STORAGE", 8)} ${pad("WRITER", 25)} ${pad("TURN", 16)} ${pad("THREAD", 36)} DIR`,
  ];
  for (const session of sessions) {
    const runtime = session.writerRuntime?.kind ?? "-";
    const writer = `${session.writerEvidence}/${runtime}`;
    lines.push(
      `${pad(session.provider, 8)} ${pad(session.origin, 10)} ${pad(session.storage, 8)} ${pad(writer, 25)} ${pad(session.turnState.state, 16)} ${pad(session.threadId, 36)} ${session.dir ?? "-"}`,
    );
  }
  return lines;
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function cmdExternal(args: string[] = []): Promise<number> {
  const unsupported = args.find((arg) => arg !== "--json");
  if (unsupported !== undefined) {
    console.error(`${usageLine("external")}\nunknown option: ${unsupported}`);
    return 1;
  }

  const machine = loadMachineConfig();
  const sessions = await observeExternalTurns(machine, discoverExternal(machine));
  if (args.includes("--json")) {
    // This projection can be much larger than a pipe buffer. Await the stream callback: bundled
    // Bun may otherwise terminate after queueing only part of a `console.log` string for a pipeline.
    await writeStdout(`${JSON.stringify(externalInventoryJson(machine.rcPrefix, sessions))}\n`);
  } else {
    for (const line of externalTableLines(sessions)) console.log(line);
  }
  return 0;
}
