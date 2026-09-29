/**
 * The compiled routed programs (`routedPrograms.ts`), carried inside the bundle, by file name.
 *
 * Null here on purpose: in a source checkout there is no artifact and nothing wants one — the shim
 * belongs to an installed machine, and a dev run must never repoint it. The release build replaces
 * this module with the real bytes, so the shipped bundle can lay the programs down beside itself
 * without a second download, a second manifest entry or a second thing that can be missing.
 */
import type { PackagedFile } from './packagedFile.ts';

export const ROUTED_ARTIFACTS: Readonly<Record<string, PackagedFile>> | null = null;
