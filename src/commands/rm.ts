import { forwardIfRemote } from "../fleet/forward.ts";
import { removeSession } from "../config/sessions.ts";
import { killSession } from "../tmux/tmux.ts";
import { log } from "../util/log.ts";
import { refusesSelf } from "./guard.ts";

export async function cmdRm(name: string | undefined, force = false): Promise<number> {
  if (!name) {
    console.log("usage: ccmux rm <name>   ·   <machine>:<name> for another fleet machine");
    return 1;
  }
  const fwd = await forwardIfRemote(name, "rm", force ? ["--force"] : []);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  if (refusesSelf("rm", name, force)) return 1;
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
