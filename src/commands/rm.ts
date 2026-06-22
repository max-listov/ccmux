import { loadMachineConfig } from "../config/machine.ts";
import { removeSession } from "../config/sessions.ts";
import { killSession } from "../tmux/tmux.ts";
import { log } from "../util/log.ts";
import { refusesSelf } from "./guard.ts";

export async function cmdRm(name: string | undefined, force = false): Promise<number> {
  if (!name) {
    console.log("usage: ccmux rm <name>");
    return 1;
  }
  if (refusesSelf("rm", name, force)) return 1;
  const m = loadMachineConfig();
  const removed = await removeSession(m, name);
  if (!removed) {
    console.log(`'${name}' not in ${m.sessionsFile}`);
    return 1;
  }
  await killSession(m, name);
  log.info({ msg: "session removed", name });
  console.log(`stopped ${name}`);
  console.log(`removed ${name} from ${m.sessionsFile} (jsonl history kept on disk)`);
  return 0;
}
