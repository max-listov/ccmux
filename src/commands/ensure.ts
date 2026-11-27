import { healOnce } from '../session/heal.ts';

/** `stitchmux ensure`: one heal pass now, the same the daemon runs every second. */
export async function cmdEnsure(): Promise<number> {
  await healOnce();
  return 0;
}
