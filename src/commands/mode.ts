import { loadMachineConfig } from "../config/machine.ts";
import { setSessionPermissionMode } from "../config/sessions.ts";
import { PermissionModeSchema } from "../config/schema.ts";
import { log } from "../util/log.ts";

const CHOICES = PermissionModeSchema.options.join("|");

/**
 * Set (or clear) a session's per-session permission-mode override.
 *   ccmux mode <name> <auto|plan|acceptEdits|bypassPermissions|dontAsk|manual>
 *   ccmux mode <name> default   → clear the override (inherit the machine default)
 * The mode is a launch-time flag, so it applies on the next `ccmux restart <name>`.
 */
export async function cmdMode(name: string | undefined, mode: string | undefined): Promise<number> {
  if (name === undefined || mode === undefined) {
    console.log(`usage: ccmux mode <name> <${CHOICES}|default>`);
    return 1;
  }
  const m = loadMachineConfig();
  const clear = mode === "default" || mode === "clear";
  const parsed = PermissionModeSchema.safeParse(mode);
  if (!clear && !parsed.success) {
    console.log(`bad mode '${mode}' (use: ${CHOICES}|default)`);
    return 1;
  }
  const value = clear ? undefined : parsed.success ? parsed.data : undefined;
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
