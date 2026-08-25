/**
 * Addressing a session by what it DOES instead of by what it is called.
 *
 * The failure this exists for is silent, which is what makes it expensive. A name is chosen once and
 * it is usually the project's; a project has several sessions and only one of them owns a given
 * decision. So an address picked from a project name resolves, delivers, and exits zero — onto the
 * neighbour. Nothing anywhere reports a problem, and the sender goes on believing it answered the
 * owner. Measured on the fleet: an hour of exactly that.
 *
 * Two properties do the work, and neither is the label itself:
 *
 *  - **A separate namespace.** `@` is not decoration. Without a sigil a role and a session name
 *    compete for one space, and we would have rebuilt the same ambiguity one level up — an address
 *    that is both a name and a role would have to pick, and picking silently is the bug.
 *  - **Ambiguity REFUSES.** A role matching two sessions must never choose one. The refusal is the
 *    mechanism; a role merely printed somewhere is documentation, and documentation is not read at
 *    the moment an address is chosen.
 *
 * And the refusal carries what the reader needs to choose: each candidate's directory and what it
 * last said. Otherwise a refusal is only a redirect to another command, and the sender guesses again
 * from the same information that misled them the first time.
 */

import { preview } from "../util/preview.ts";

export const ROLE_SIGIL = "@";

/** Is this token asking for a role rather than naming a session? */
export function isRoleToken(token: string): boolean {
  return token.startsWith(ROLE_SIGIL) && token.length > ROLE_SIGIL.length;
}

/** The role asked for. Only meaningful for a token `isRoleToken` accepts. */
export function roleOf(token: string): string {
  return token.slice(ROLE_SIGIL.length);
}

/** One session as a role lookup sees it — the same three facts a person uses to pick by hand. */
export interface RoleCandidate {
  name: string;
  role: string | null;
  /** Working directory: the closest thing to a role that every session has always declared. */
  dir: string;
  /** What this session last said, for telling two sessions of one project apart. */
  lastText: string | null;
}

export type RoleResolution = { name: string } | { error: string };

function describe(c: RoleCandidate): string {
  // Flattened: a transcript line carries newlines, and a refusal whose candidates sprawl over the
  // screen is one nobody reads to the end — which would put us back at guessing.
  const said = c.lastText === null || c.lastText.trim() === ""
    ? "nothing said yet"
    : preview(c.lastText.replace(/\s+/g, " ").trim(), 80);
  return `  ${c.name}  (${c.dir})\n    last: ${said}`;
}

/**
 * Resolve `@role` against the sessions of one machine.
 *
 * `label` is how the machine should be named back to the reader (`host-a:` or empty for local), so
 * the addresses in a refusal are the exact strings to retry with rather than something to assemble.
 */
export function resolveRole(token: string, candidates: readonly RoleCandidate[], label = ""): RoleResolution {
  const want = roleOf(token);
  const matches = candidates.filter((c) => c.role === want);
  if (matches.length === 1) return { name: (matches[0] as RoleCandidate).name };
  const where = label === "" ? "this machine" : label.replace(/:$/, "");
  if (matches.length === 0) {
    const declared = [...new Set(candidates.map((c) => c.role).filter((r): r is string => r !== null))].sort();
    // Either name what IS there, or say how to put it there. A bare "not found" would send the
    // reader back to guessing from the same names that misled them.
    const known = declared.length === 0
      ? `nothing there declares a role yet; declare one with: ccmux role ${label}<session> ${want}`
      : `roles declared there: ${declared.map((r) => `${ROLE_SIGIL}${r}`).join(", ")}`;
    return { error: `no session matches role '${ROLE_SIGIL}${want}' on ${where} — ${known}` };
  }
  // Never pick one. The whole point is that choosing silently is the failure being removed.
  const lines = matches.map((c) => `${describe(c)}\n    address: ${label}${c.name}`).join("\n");
  return {
    error:
      `role '${ROLE_SIGIL}${want}' matches ${matches.length} sessions — refusing to choose one.\n${lines}\n` +
      `Address the one you mean by name, or give them distinct roles: ccmux role <session> <role>`,
  };
}
