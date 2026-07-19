import { loadMachineConfig } from "../config/machine.ts";
import { loadLedger, loadCursors, unreadFor, markRead, fmtMessage } from "../chat/store.ts";

/**
 * Show a session's unread chat inbox (messages addressed to it) and advance its read cursor.
 * Name defaults to THIS session (CCMUX_SESSION). `--peek` shows without marking read.
 *   ccmux inbox [name] [--peek]
 */
export async function cmdInbox(args: string[]): Promise<number> {
  const peek = args.includes("--peek");
  const name = args.find((a) => !a.startsWith("--")) ?? process.env.CCMUX_SESSION;
  if (name === undefined || name === "") {
    console.log("usage: ccmux inbox <name> [--peek]   (name defaults to CCMUX_SESSION)");
    return 1;
  }
  const m = loadMachineConfig();
  const ledger = loadLedger(m);
  const unread = unreadFor(name, ledger, loadCursors(m));
  if (unread.length === 0) {
    console.log(`(${name}: no unread messages)`);
  } else {
    for (const { msg } of unread) console.log(fmtMessage(msg));
  }
  if (!peek) await markRead(m, name, ledger.length);
  return 0;
}
