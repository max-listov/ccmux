import { loadMachineConfig } from "../config/machine.ts";
import { capturePane } from "../tmux/tmux.ts";

export async function cmdLogs(name: string | undefined, args: string[]): Promise<number> {
  if (!name) {
    console.log("usage: ccmux logs <name> [lines] [--json]");
    return 1;
  }
  const json = args.includes("--json");
  const lineArg = args.find((a) => /^\d+$/.test(a));
  const lines = lineArg ? Number.parseInt(lineArg, 10) : 100;
  const m = loadMachineConfig();
  const text = await capturePane(m, name, lines);
  if (json) {
    console.log(JSON.stringify({ session: name, capturedAt: new Date().toISOString(), lines, text }));
  } else {
    process.stdout.write(text);
  }
  return 0;
}
