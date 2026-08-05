import { forwardIfRemote } from "../fleet/forward.ts";
import { capturePane } from "../tmux/tmux.ts";

export async function cmdLogs(name: string | undefined, args: string[]): Promise<number> {
  if (!name) {
    console.log("usage: ccmux logs <name> [lines] [--json]   ·   <machine>:<name> for another fleet machine");
    return 1;
  }
  const fwd = await forwardIfRemote(name, "logs", args);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const json = args.includes("--json");
  const lineArg = args.find((a) => /^\d+$/.test(a));
  const lines = lineArg ? Number.parseInt(lineArg, 10) : 100;
  const text = await capturePane(m, name, lines);
  if (json) {
    console.log(JSON.stringify({ session: name, capturedAt: new Date().toISOString(), lines, text }));
  } else {
    process.stdout.write(text);
  }
  return 0;
}
