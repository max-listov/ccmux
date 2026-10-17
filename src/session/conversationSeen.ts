import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { STATE_DIR } from '../config/paths.ts';

/**
 * The evidence that a conversation EXISTED, kept where a restart cannot erase it.
 *
 * The supervisor refuses to start a new conversation over one whose file has gone missing, so it
 * needs to know the conversation was real. Having launched is not that knowledge: the launch stamp
 * is written before the agent starts, and the agent creates the conversation file only with the
 * first message, so a session closed on its folder-trust question launched without ever having a
 * conversation. The stamp is also wiped by every stop, restart and renew (`clearStatus`).
 *
 * What proves a conversation is having SEEN its file. This records that, per name, with the
 * conversation's uuid inside the file: a renewed session has a new uuid and so inherits nothing from
 * the conversation it replaced, which a name-only marker would hand to it. It lives in its own
 * directory and is not part of `clearStatus`. Only the registry-pinned uuid is recorded, so a
 * conversation that forked away or was cleared does not overwrite the pinned one's evidence.
 */
const SEEN_DIR = `${STATE_DIR}/seen`;
const safe = (name: string): string => name.replace(/[^\w.-]/g, '_');
const seenPath = (name: string): string => `${SEEN_DIR}/${safe(name)}`;

/** Record that this uuid's conversation file has been observed. Idempotent, best-effort: a failed
 *  write leaves the previous guard behaviour (no evidence), never a failed launch. */
export function markConversationSeen(name: string, uuid: string): void {
  try {
    if (conversationSeen(name, uuid)) return;
    mkdirSync(SEEN_DIR, { recursive: true });
    writeFileSync(seenPath(name), uuid);
  } catch {
    // best-effort bookkeeping
  }
}

export function conversationSeen(name: string, uuid: string): boolean {
  try {
    const path = seenPath(name);
    return existsSync(path) && readFileSync(path, 'utf8').trim() === uuid;
  } catch {
    return false;
  }
}

export function clearConversationSeen(name: string): void {
  try {
    rmSync(seenPath(name), { force: true });
  } catch {
    // best-effort cleanup
  }
}
