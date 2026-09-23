/**
 * The compiled status-line program, carried inside the bundle.
 *
 * Null here on purpose: in a source checkout there is no artifact and nothing wants one — the shim
 * belongs to an installed machine, and a dev run must never repoint it. The release build replaces
 * this module with the real bytes, so the shipped bundle can lay the program down beside itself
 * without a second download, a second manifest entry or a second thing that can be missing.
 */
export interface StatusLineArtifact {
  /** gzip, base64 — the same shape the packaged custom runtime travels in. */
  data: string;
  sha256: string;
}

export const STATUS_LINE_ARTIFACT: StatusLineArtifact | null = null;
