import { forwardIfRemote } from "../fleet/forward.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { findSession, loadSessions, setSessionRole } from "../config/sessions.ts";
import { SessionSchema } from "../config/schema.ts";
import { ROLE_SIGIL } from "../chat/roleAddress.ts";
import { log } from "../util/log.ts";

const USAGE =
  `usage: ccmux role <name> <role>  ·  ccmux role <name> --none  ·  ccmux role (list)\n` +
  `       <machine>:<name> for another fleet machine`;

/**
 * `ccmux role` — declare what a session is FOR, so an address can select on it.
 *
 * It takes effect immediately and deliberately: unlike `mode`, `chat` and `env-file`, no launch
 * reads a role, so there is nothing to restart. That is the property that keeps the field honest.
 * A second name that costs a restart to correct is one people put off correcting, and a role nobody
 * corrects goes on being trusted while it lies — worse than having no role at all.
 */
export async function cmdRole(args: string[]): Promise<number> {
  const positionals = args.filter((a) => a !== "--none");
  const clear = args.includes("--none");
  const target = positionals[0];

  if (target === undefined) return listRoles();

  const forwarded = await forwardIfRemote(target, "role", positionals.slice(1).concat(clear ? ["--none"] : []));
  if (forwarded.done) return forwarded.code;
  const { m, session: name } = forwarded;

  const value = positionals[1];
  if (!clear && value === undefined) {
    // Asking about one session is a reading, not a malformed write.
    const s = findSession(loadSessions(m), name);
    if (!s) return console.error(`role: no such session '${name}'`), 1;
    console.log(s.role === undefined ? `${name}: no role declared` : `${name}: ${ROLE_SIGIL}${s.role}`);
    return 0;
  }
  if (clear && value !== undefined) return console.error(`role: give a role or --none, not both\n${USAGE}`), 1;

  if (!clear) {
    const parsed = SessionSchema.shape.role.safeParse(value);
    if (!parsed.success) {
      // A role is an address token, so it lives under the same rules as a session name. Saying so is
      // the whole message: the alternative is a Zod dump about a regex.
      return console.error(`role: '${value}' cannot be a role — it is an address token, so no whitespace, ':', '|' or '#'`), 1;
    }
  }

  if (!(await setSessionRole(m, name, clear ? undefined : value))) {
    return console.error(`role: no such session '${name}'`), 1;
  }
  log.info({ msg: "session role declared", name, role: clear ? null : value });
  if (clear) {
    console.log(`${name}: role cleared — addressed by name again`);
    return 0;
  }
  console.log(`${name}: ${ROLE_SIGIL}${value}   ·   address it as: ccmux msg ${m.rcPrefix}:${ROLE_SIGIL}${value} "…"`);
  return 0;
}

/** Every declared role on this machine, and what answers to it. Roles sharing a name are shown
 *  together, because that is the state an address on them would refuse — better seen here than
 *  discovered by a refusal. */
function listRoles(): number {
  const m = loadMachineConfig();
  const sessions = loadSessions(m).filter((s) => s.role !== undefined);
  if (sessions.length === 0) {
    console.log("no session on this machine declares a role.");
    console.log(`declare one: ccmux role <name> <role>   — then address it as ${m.rcPrefix}:${ROLE_SIGIL}<role>`);
    return 0;
  }
  const byRole = new Map<string, string[]>();
  for (const s of sessions) byRole.set(s.role as string, [...(byRole.get(s.role as string) ?? []), s.name]);
  for (const role of [...byRole.keys()].sort()) {
    const names = byRole.get(role) as string[];
    const shared = names.length > 1 ? "   ← shared: an address on this role refuses until they differ" : "";
    console.log(`${ROLE_SIGIL}${role}  ${names.join(", ")}${shared}`);
  }
  return 0;
}
