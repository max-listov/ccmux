import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { loadSessions } from '../../session/registry.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { HistorySearch } from '../historySearch.ts';
import { claudeProfile, knownProjectsDirs } from './profileRoot.ts';

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
  return safeRealpath(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

function safeRealpath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir; // dir may not exist yet at first launch — fall back to the raw path
  }
}

/** Provider hook: the expected transcript path for this session (Claude always has one). It lives
 *  under the session's own profile — see `claudeProfile` — not under the machine's default root. */
export function historyFile(s: Session, m: MachineConfig): string {
  return histFile(s.dir, s.uuid, claudeProfile(s, m).projectsDir);
}

/**
 * The deterministic resume branch, re-evaluated every launch:
 *  - transcript exists → --resume the same pinned conversation
 *  - first launch ever → --session-id creates the conversation AT this uuid
 */
export function resumeArgs(uuid: string, dir: string, projectsDir: string): string[] {
  return existsSync(histFile(dir, uuid, projectsDir)) ? ['--resume', uuid] : ['--session-id', uuid];
}

/**
 * The same conversation found under a DIFFERENT project directory than this session expects.
 *
 * Claude derives its history folder from the working directory, so renaming or moving a project
 * relocates the conversation while the registry still points at the old path. The expected file then
 * does not exist — which is indistinguishable from a genuine first launch unless someone looks for
 * the uuid elsewhere. Measured on a real fleet: one session had 140 MB of history sitting under the
 * previous directory's encoding while a fresh, empty conversation was being written at the new one.
 *
 * Reports the fullest such file (a relocation leaves the real history far larger than anything a
 * fresh start has written), every attempted projects root and any read that could not establish
 * absence. The supervisor must not turn an incomplete search into a fresh conversation.
 */
export function findHistoryElsewhere(s: Session, m: MachineConfig): HistorySearch {
  const expected = normalize(historyFile(s, m));
  const roots = knownProjectsDirs([s, ...loadSessions(m)], m);
  const failures: HistorySearch['failures'] = [];
  let best: { path: string; size: number } | null = null;
  // Every root a session on this machine writes to: a conversation that is missing at its own
  // profile's path may sit under the machine's default root or under another profile's, which is
  // what a changed `envFile` leaves behind.
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) failures.push({ path: root, reason: String(error) });
      continue;
    }
    for (const dir of dirs) {
      const candidate = join(root, dir, `${s.uuid}.jsonl`);
      try {
        const stat = statSync(candidate);
        // existsSync cannot distinguish an absent expected file from an inaccessible one.
        // Observe it before excluding it from relocation candidates so that a read failure blocks.
        if (candidate === expected || !stat.isFile()) continue;
        const size = stat.size;
        if (best === null || size > best.size) best = { path: candidate, size };
      } catch (error) {
        if (!hasCode(error, 'ENOENT') && (candidate === expected || !hasCode(error, 'ENOTDIR')))
          failures.push({ path: candidate, reason: String(error) });
      }
    }
  }
  return { found: best?.path ?? null, roots, failures };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
