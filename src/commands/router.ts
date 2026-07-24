import { loadMachineConfig } from "../config/machine.ts";
import { setSessionRouter } from "../config/sessions.ts";
import { log } from "../util/log.ts";

const USAGE = "usage: ccmux router <on <name> | off <name>>";

/**
 * Promote/demote a session to/from ROUTER mode (the autonomous-manager protocol):
 *   ccmux router on  <name>   — add the router protocol module + enable chat
 *   ccmux router off <name>   — remove the router protocol module (chat left as-is)
 * Launch-time, like `ccmux mode`/chat framing: applies on the next `ccmux restart <name>`.
 */
export async function cmdRouter(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "on" && sub !== "off") {
    console.log(USAGE);
    return sub === undefined ? 0 : 1;
  }
  const name = args[1];
  if (name === undefined) {
    console.log(`usage: ccmux router ${sub} <name>`);
    return 1;
  }
  const m = loadMachineConfig();
  const ok = await setSessionRouter(m, name, sub === "on");
  if (!ok) {
    console.log(`no such session: ${name}`);
    return 1;
  }
  log.info({ msg: "router toggled", name, on: sub === "on" });
  console.log(`${name}: router ${sub === "on" ? "on (chat enabled)" : "off"} — applies on: ccmux restart ${name}`);
  return 0;
}
