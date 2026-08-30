import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { forwardIfRemote } from "../fleet/forward.ts";
import { findSession, loadSessions, updateSessionUuid } from "../config/sessions.ts";
import { clearLifecycleBlock } from "../config/lifecycleBlocks.ts";
import { providerFor } from "../agent/index.ts";
import { chatOverrideLabel } from "../config/chat.ts";
import { startSession } from "./lifecycle.ts";
import { killSession } from "../tmux/tmux.ts";
import { log } from "../util/log.ts";
import type { Session } from "../types.ts";
import { hasNativeRuntime } from "../runtime/capabilities.ts";

/**
 * Why this refuses by default. A session's conversation is the work in it; renewing pins a fresh
 * uuid and the old thread stops being what this session resumes. When the file is gone that costs
 * nothing — there is nothing left to keep. When it is still there, the same command silently
 * abandons real history, so it says what it would drop and stops. Pure, so the rule is testable
 * without a registry or a tmux server.
 */
export function renewRefusal(name: string, historyFile: string | null, present: boolean, force: boolean): string | null {
  if (!present || force) return null;
  return (
    `${name} still has its conversation at ${historyFile ?? "its expected path"}. ` +
    "Renewing pins a NEW uuid, so that history stops being what this session resumes — it stays on disk, but nothing points at it. " +
    `Continue it instead with: ccmux restart ${name}   ·   or renew deliberately: ccmux renew ${name} --force`
  );
}

/** The line printed after a successful renewal — names what was kept, because that is the point. */
export function renewSummary(s: Session, uuid: string): string {
  const kept = [
    `dir ${s.dir}`,
    `agent ${s.agent}`,
    ...(s.permissionMode !== undefined ? [`mode ${s.permissionMode}`] : []),
    ...(chatOverrideLabel(s) !== null ? [chatOverrideLabel(s) as string] : []),
    ...(s.promptModules.length > 0 ? [`modules ${s.promptModules.join("+")}`] : []),
  ];
  return `renewed ${s.name}: new conversation ${uuid}. Kept: ${kept.join(", ")}.`;
}

/**
 * Give a registered session a fresh conversation without demolishing the session.
 *   ccmux renew <name>            → only when the pinned conversation is gone
 *   ccmux renew <name> --force    → abandon a conversation that is still there
 *
 * The recovery path for a transcript that was deleted underneath a session: the block that stopped
 * it exists precisely so a new conversation is never started in silence, and until now the only way
 * past it was `rm` + `new` — which also threw away the session's mode, chat override and prompt
 * modules, none of which had anything to do with the missing file.
 */
export async function cmdRenew(name: string | undefined, args: string[] = []): Promise<number> {
  if (name === undefined) {
    console.log("usage: ccmux renew <name> [--force]   ·   <machine>:<name> for another fleet machine");
    return 1;
  }
  const force = args.includes("--force");
  const fwd = await forwardIfRemote(name, "renew", force ? ["--force"] : []);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;

  const s = findSession(loadSessions(m), name);
  if (!s) {
    console.log(`unknown session: ${name}`);
    return 1;
  }
  if (hasNativeRuntime(s) || s.runtime === "native") {
    console.error("Native runtimes assign continuation identities; use new for a fresh managed session or restart to resume this identity.");
    return 1;
  }
  const historyFile = providerFor(s).historyFile(s, m);
  const present = historyFile !== null && existsSync(historyFile);
  const refusal = renewRefusal(name, historyFile, present, force);
  if (refusal !== null) {
    console.log(refusal);
    return 1;
  }

  const uuid = randomUUID();
  if (!(await updateSessionUuid(m, name, uuid))) {
    console.log(`could not update ${name} in the registry`);
    return 1;
  }
  // The verdict was about the conversation that just stopped being this session's.
  clearLifecycleBlock(m, name);
  await killSession(m, name); // a supervisor still holding the old uuid must not race the new one
  await startSession(m, name, s.dir);
  log.info({ msg: "session renewed", name, uuid, abandoned: present });
  console.log(renewSummary(s, uuid));
  return 0;
}
