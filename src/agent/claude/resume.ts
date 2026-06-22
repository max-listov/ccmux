import { realpathSync, existsSync } from "node:fs";
import type { MachineConfig, Session } from "../../types.ts";

/**
 * Path to a session's conversation transcript.
 *
 * Claude encodes a project dir as `<projectsDir>/<dir-with-slashes-as-dashes>/<uuid>.jsonl`.
 *
 * P0-4: Claude encodes the REALPATH of the dir — it resolves symlinks first
 * (/tmp→/private/tmp on macOS, the user's sshfs ~/mnt/* mounts, any symlinked home).
 * Encoding the raw `dir` would compute the wrong directory, existsSync would miss
 * the jsonl, and resume would silently fall back to --session-id (which then errors
 * "already in use" on the next launch). So we encode realpath, exactly like Claude.
 */
export function histFile(dir: string, uuid: string, projectsDir: string): string {
  return `${projectsDir}/${encodeDir(dir)}/${uuid}.jsonl`;
}

export function encodeDir(dir: string): string {
  // Claude encodes the project dir by replacing EVERY non-alphanumeric char with "-" (not
  // just "/"): `/Users/x/cc.dot_test` → `-Users-x-cc-dot-test`. Matching this EXACTLY is
  // critical — a mismatch means the transcript jsonl isn't found → resume falls back to
  // --session-id → "already in use" relaunch loop. (Verified against real ~/.claude/projects.)
  return safeRealpath(dir).replace(/[^a-zA-Z0-9]/g, "-");
}

function safeRealpath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir; // dir may not exist yet at first launch — fall back to the raw path
  }
}

/** Provider hook: the expected transcript path for this session (Claude always has one). */
export function historyFile(s: Session, m: MachineConfig): string {
  return histFile(s.dir, s.uuid, m.projectsDir);
}

/**
 * The deterministic resume branch, re-evaluated every launch:
 *  - transcript exists → --resume the same pinned conversation
 *  - first launch ever → --session-id creates the conversation AT this uuid
 */
export function resumeArgs(uuid: string, dir: string, projectsDir: string): string[] {
  return existsSync(histFile(dir, uuid, projectsDir))
    ? ["--resume", uuid]
    : ["--session-id", uuid];
}
