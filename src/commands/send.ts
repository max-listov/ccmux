import { forwardIfRemote } from "../fleet/forward.ts";
import { sendKeysLiteral, sendKeysNamed } from "../tmux/tmux.ts";

export async function cmdSend(name: string | undefined, keys: string[]): Promise<number> {
  if (!name || keys.length === 0) {
    console.log("usage: ccmux send <name> <keys...>   ·   <machine>:<name> for another fleet machine");
    return 1;
  }
  const fwd = await forwardIfRemote(name, "send", keys);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const text = keys.join(" ");
  const ok = await sendKeysLiteral(m, name, text);
  if (!ok) {
    console.log(`send failed: ${name} not running?`);
    return 1;
  }
  // let readline drain the literal text before the separate Enter (avoids a race)
  await Bun.sleep(150);
  await sendKeysNamed(m, name, "Enter");
  console.log(`sent to ${name}: ${text}`);
  return 0;
}
