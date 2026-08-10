import { forwardIfRemote } from "../fleet/forward.ts";
import { setSessionPermissionMode } from "../config/sessions.ts";
import { PermissionModeSchema } from "../config/schema.ts";
import { log } from "../util/log.ts";
import { UID } from "../env.ts";
import { escalationRefusal } from "../agent/claude/launch.ts";

const CHOICES = PermissionModeSchema.options.join("|");

/**
 * Set (or clear) a session's per-session permission-mode override.
 *   ccmux mode <name> <auto|plan|acceptEdits|bypassPermissions|dontAsk|manual>
 *   ccmux mode <name> default   → clear the override (inherit the machine default)
 * The mode is a launch-time flag, so it applies on the next `ccmux restart <name>`.
 */
export async function cmdMode(name: string | undefined, mode: string | undefined): Promise<number> {
  if (name === undefined || mode === undefined) {
    console.log(`usage: ccmux mode <name> <${CHOICES}|default>   ·   <machine>:<name> for another fleet machine`);
    return 1;
  }
  const fwd = await forwardIfRemote(name, "mode", [mode]);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const clear = mode === "default" || mode === "clear";
  const parsed = PermissionModeSchema.safeParse(mode);
  if (!clear && !parsed.success) {
    console.log(`bad mode '${mode}' (use: ${CHOICES}|default)`);
    return 1;
  }
  const value = clear ? undefined : parsed.success ? parsed.data : undefined;
  // Refuse where the decision is MADE, not where it is applied. Under a root daemon the provider
  // itself rejects escalated modes, so accepting one here would write a setting that can never take
  // effect — and, if the launcher ever stopped guarding, would put the session into a crash loop.
  // That is exactly what happened once: the setting was accepted, the launcher downgraded it in
  // silence, and the box looked configured while behaving otherwise.
  const refusal = value === undefined ? null : escalationRefusal(value, UID === 0);
  if (refusal !== null) {
    console.log(refusal);
    return 1;
  }
  const ok = await setSessionPermissionMode(m, name, value);
  if (!ok) {
    console.log(`no such session: ${name}`);
    return 1;
  }
  log.info({ msg: "session permission mode set", name, mode: value ?? null });
  console.log(`${name}: permission mode → ${value ?? `default (${m.permissionMode})`}`);
  console.log(`apply: ccmux restart ${name}   (mode is set at launch)`);
  return 0;
}
