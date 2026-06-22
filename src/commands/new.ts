import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadMachineConfig } from "../config/machine.ts";
import { appendSession } from "../config/sessions.ts";
import { SessionSchema } from "../config/schema.ts";
import { log } from "../util/log.ts";
import { cmdStart } from "./lifecycle.ts";

/**
 * Register a new managed session and start it. Flags after `--` are stored verbatim
 * as an array (e.g. `ccmux new cc-x /dir -- --model claude-opus-4-8[1m]`).
 */
export async function cmdNew(
  name: string | undefined,
  dir: string | undefined,
  flags: string[],
): Promise<number> {
  if (!name || !dir) {
    console.log("usage: ccmux new <name> <dir> [-- claude flags...]");
    return 1;
  }
  if (name.includes("|")) {
    console.log("name cannot contain '|'");
    return 1;
  }
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    console.log(`dir not found: ${abs}`);
    return 1;
  }
  const m = loadMachineConfig();
  try {
    const session = SessionSchema.parse({ name, dir: abs, uuid: randomUUID(), flags });
    await appendSession(m, session);
    log.info({ msg: "session registered", name, dir: abs, uuid: session.uuid });
    console.log(`added: ${JSON.stringify(session)}`);
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  return cmdStart(name);
}
