import { existsSync } from "node:fs";
import { forwardIfRemote } from "../fleet/forward.ts";
import { loadSessions, setSessionEnvFile } from "../config/sessions.ts";
import { envFilePath, envFiles, envFileKeys, fileDigest } from "../agent/launchInputs.ts";
import { readLaunchStamp } from "../agent/sessionStatus.ts";
import { inheritsUndeclaredEnv } from "../agent/sessionEnv.ts";
import { loadMachineConfig } from "../config/machine.ts";
import type { MachineConfig, Session } from "../types.ts";
import { log } from "../util/log.ts";

const USAGE =
  "usage: ccmux env-file <name> <path>  ·  ccmux env-file <name> --none  ·  ccmux env-file --adopt [--dry-run]\n" +
  "       <machine>:<name> for another fleet machine";

/**
 * A session's environment file is DECLARED here, and nowhere else.
 *
 * Before this existed the same effect happened by accident: the supervisor's runtime loaded whatever
 * `.env` sat in a session's directory and the launcher passed it to the agent — and to every process
 * the agent spawns. So this command is not a new capability so much as the moment that capability
 * stopped being invisible. It is a launch-time field, like `mode` and `chat`, so it applies on the
 * next restart and the command says so.
 */

/** Sessions still living on variables nobody declared: their launch stamp digested a directory env
 *  file, and they have no `envFile` of their own. This is the migration list, and it empties itself
 *  as sessions are declared and restarted — which is what makes "is the migration done" a fact. */
export interface InheritingSession {
  session: Session;
  /** The directory env file(s) that are still reaching this session's agent. */
  paths: string[];
  keys: string[];
}

export function inheritingSessions(m: MachineConfig, nodeEnv: string | undefined = process.env.NODE_ENV): InheritingSession[] {
  const out: InheritingSession[] = [];
  for (const session of loadSessions(m)) {
    if (!inheritsUndeclaredEnv(session, readLaunchStamp(session.name), nodeEnv)) continue;
    const paths = envFiles(session.dir, nodeEnv).filter((p) => fileDigest(p) !== null);
    out.push({ session, paths, keys: [...new Set(paths.flatMap((p) => envFileKeys(p)))].sort() });
  }
  return out;
}

async function adopt(m: MachineConfig, dryRun: boolean): Promise<number> {
  const pending = inheritingSessions(m);
  if (pending.length === 0) {
    console.log("nothing to adopt — no session is running on an undeclared env file.");
    return 0;
  }
  for (const { session, paths, keys } of pending) {
    // The FIRST path is the one to declare: `envFiles` returns them in the runtime's own precedence
    // order, and `.env` is the file people mean. Declaring a list would need a precedence puzzle the
    // schema deliberately does not have.
    const path = paths[0] as string;
    console.log(`${session.name}: declare ${path} (${keys.length} name(s))${dryRun ? "" : " …"}`);
    if (dryRun) continue;
    if (!(await setSessionEnvFile(m, session.name, path))) {
      console.log(`  skipped — '${session.name}' disappeared while adopting`);
      continue;
    }
    log.info({ msg: "env file adopted", name: session.name, path });
  }
  if (dryRun) {
    console.log(`\n${pending.length} session(s) would be declared. Run without --dry-run to apply.`);
    return 0;
  }
  console.log(`\napply: ccmux restart --all   (the env recipe is read at launch)`);
  console.log("Until then those sessions keep the variables they were started with.");
  return 0;
}

export async function cmdEnvFile(args: string[]): Promise<number> {
  if (args[0] === "--adopt") return adopt(loadMachineConfig(), args.includes("--dry-run"));
  const name = args[0];
  const value = args[1];
  if (name === undefined || value === undefined) {
    console.log(USAGE);
    return 1;
  }
  const fwd = await forwardIfRemote(name, "env-file", [value]);
  if (fwd.done) return fwd.code;
  const { session: local, m } = fwd;

  const clear = value === "--none" || value === "none";
  if (!clear) {
    const target = loadSessions(m).find((s) => s.name === local);
    if (target === undefined) {
      console.log(`no such session: ${local}`);
      return 1;
    }
    const resolved = envFilePath({ dir: target.dir, envFile: value });
    // Not a refusal: a supervisor whose sessions refuse to boot is worse than a session one variable
    // short, and the file may legitimately appear later. Said out loud, and repeated by `doctor`.
    if (resolved !== null && !existsSync(resolved)) {
      console.log(`warning: ${resolved} does not exist yet — the session will still start, and ccmux will keep saying so.`);
    }
  }
  const ok = await setSessionEnvFile(m, local, clear ? undefined : value);
  if (!ok) {
    console.log(`no such session: ${local}`);
    return 1;
  }
  log.info({ msg: "session env file set", name: local, envFile: clear ? null : value });
  console.log(`${local}: env file → ${clear ? "none (only the declared base environment)" : value}`);
  console.log(`apply: ccmux restart ${local}   (the env recipe is read at launch)`);
  return 0;
}
