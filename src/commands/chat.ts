import { loadMachineConfig } from "../config/machine.ts";
import { setSessionChatEnabled } from "../config/sessions.ts";
import { loadLedger, fmtMessage } from "../chat/store.ts";
import { log } from "../util/log.ts";

const USAGE = "usage: ccmux chat <log [-n N] | on <name> | off <name>>";

/**
 * Chat administration + inspection:
 *   ccmux chat log [-n N]    — the append-only ledger (tail of N, default 30) — the full debug log
 *   ccmux chat on  <name>    — enable inter-agent chat for a session (default is OFF)
 *   ccmux chat off <name>    — disable it
 */
export async function cmdChat(args: string[]): Promise<number> {
  const sub = args[0];
  const m = loadMachineConfig();

  if (sub === "log") {
    const nIdx = args.indexOf("-n");
    const parsed = nIdx >= 0 ? Number.parseInt(args[nIdx + 1] ?? "", 10) : 30;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    const ledger = loadLedger(m);
    if (ledger.length === 0) {
      console.log("(chat log empty)");
      return 0;
    }
    for (const msg of ledger.slice(-limit)) console.log(fmtMessage(msg));
    return 0;
  }

  if (sub === "on" || sub === "off") {
    const name = args[1];
    if (name === undefined) {
      console.log(`usage: ccmux chat ${sub} <name>`);
      return 1;
    }
    const ok = await setSessionChatEnabled(m, name, sub === "on");
    if (!ok) {
      console.log(`no such session: ${name}`);
      return 1;
    }
    log.info({ msg: "chat toggled", name, enabled: sub === "on" });
    console.log(`${name}: chat ${sub === "on" ? "enabled" : "disabled"}`);
    return 0;
  }

  console.log(USAGE);
  return sub === undefined ? 0 : 1;
}
