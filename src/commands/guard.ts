/**
 * `_run` sets STITCHMUX_SESSION=<name> in each spawned claude's env, inherited by that
 * session's Bash children. So a stitchmux invoked from inside a session can recognize
 * "self" and refuse to rm/stop the session it's being called from (unless --force).
 *
 * Reads process.env live (not a cached const) so it's testable and reflects the actual
 * calling context. The daemon process has no STITCHMUX_SESSION, so it can stop/rm anything.
 */
export function refusesSelf(verb: string, name: string, force: boolean): boolean {
  const self = process.env.STITCHMUX_SESSION;
  if (!force && self !== undefined && name === self) {
    console.log(
      `refusing to ${verb} '${name}': you are calling from inside it. pass --force to override.`,
    );
    return true;
  }
  return false;
}
