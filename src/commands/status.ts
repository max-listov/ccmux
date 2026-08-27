import { loadMachineConfig } from "../config/machine.ts";
import { readMonitoringStatus } from "../monitoring/read.ts";

export async function cmdStatus(args: string[]): Promise<number> {
  if (args.some((arg) => arg !== "--json")) {
    console.error("usage: ccmux status [--json]");
    return 1;
  }
  const result = readMonitoringStatus(loadMachineConfig());
  const text = args.includes("--json") ? JSON.stringify(result) : result.snapshot === null
    ? `status ${result.status}: ${result.reason}`
    : [`status live · ${result.snapshot.sessions.length} managed · ${result.snapshot.omitted} omitted`,
      ...result.snapshot.sessions.map((s) => `${s.rc} ${s.agent} ${s.state} ${s.model ?? "unknown"} ${s.dir}`)].join("\n");
  await new Promise<void>((resolve, reject) => process.stdout.write(`${text}\n`, (error) => error ? reject(error) : resolve()));
  return result.status === "live" ? 0 : result.status === "stale" ? 2 : 3;
}
