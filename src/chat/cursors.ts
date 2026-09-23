import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomicSync } from 'stitchkit/files';
import type { ChatCursors, MachineConfig, ManagedPeer } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { withLock } from '../util/lock.ts';
import { managedPeerKey } from './identity.ts';
import { type LedgerSlot, loadLedger } from './ledger.ts';
import { ChatCursorsSchema } from './messageSchema.ts';
import { chatPaths } from './store.ts';

/**
 * The cursors could not be read, and delivery must stop rather than guess.
 *
 * An empty answer is not a safe default here. Immediate mail counts as delivered only by
 * `delivered[recipient]`; with that at zero the daemon delivers each recipient's mail again from its
 * first letter ever — a whole history of instructions, replayed into live agents as if new.
 */
export class CursorsUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `chat cursors unreadable (${path}: ${reason}) — delivery is held. Repair the file, or move it ` +
        'aside: ccmux then resumes from the present, and mail queued at that moment stays in the ' +
        'ledger (ccmux chat log) instead of being delivered',
    );
  }
}

/**
 * Cursors for a ledger that has none: everything already written counts as seen.
 *
 * The first run on a machine has an empty ledger, so this is the ordinary empty start. A MISSING
 * file beside a non-empty ledger is the other case — deleted by hand, or lost — and starting from
 * zero there is the same replay the unreadable case refuses. Starting at the present can leave a
 * letter queued at that moment undelivered; it stays readable in the ledger, and nothing is repeated.
 */
export function armedCursors(ledger: readonly LedgerSlot[]): ChatCursors {
  const at: Record<string, number> = {};
  for (const slot of ledger)
    if (slot !== null && slot.to.kind === 'managed') at[managedPeerKey(slot.to)] = ledger.length;
  return ChatCursorsSchema.parse({ read: at, delivered: { ...at } });
}

/** Read the cursors. Missing → armed at the present (and persisted, so the present stays put);
 *  unreadable → `CursorsUnreadableError`, never an empty object. */
export function loadCursors(m: MachineConfig): ChatCursors {
  const { cursors } = chatPaths(m);
  if (!existsSync(cursors)) {
    const armed = armedCursors(loadLedger(m));
    mkdirSync(dirname(cursors), { recursive: true });
    writeFileAtomicSync(cursors, `${JSON.stringify(armed, null, 2)}\n`);
    return armed;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cursors, 'utf8'));
  } catch (error) {
    throw new CursorsUnreadableError(
      cursors,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = ChatCursorsSchema.safeParse(raw);
  if (!parsed.success)
    throw new CursorsUnreadableError(cursors, parsed.error.issues[0]?.message ?? 'schema');
  return parsed.data;
}

/**
 * Persist the daemon's cursors without undoing anyone else's.
 *
 * The daemon holds its cursors for a whole pass — seconds, while it captures panes — and saved them
 * whole at the end, so an `inbox` that marked mail read in the meantime was silently reverted. Every
 * field but `read` is the daemon's alone; `read` only ever moves forward, from either side. So the
 * write re-reads the file under a lock and keeps the further of the two `read` positions for each
 * recipient: neither writer can move another's progress backwards.
 */
export async function saveCursors(m: MachineConfig, c: ChatCursors): Promise<void> {
  await commitCursors(m, (fresh) => ({ ...c, read: furthest(fresh.read, c.read) }));
}

/** Advance a recipient's read cursor to the whole-ledger length (everything up to now seen). */
export async function markRead(
  m: MachineConfig,
  recipient: ManagedPeer,
  ledgerLen: number,
): Promise<void> {
  await commitCursors(m, (fresh) => ({
    ...fresh,
    read: furthest(fresh.read, { [managedPeerKey(recipient)]: ledgerLen }),
  }));
}

export function furthest(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out = { ...a };
  for (const [key, at] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, at);
  return out;
}

/** The one write path: read the file as it is now, apply the change, write, all under one lock. */
export async function commitCursors(
  m: MachineConfig,
  change: (fresh: ChatCursors) => ChatCursors,
): Promise<void> {
  const { cursors } = chatPaths(m);
  mkdirSync(dirname(cursors), { recursive: true });
  await withLock(
    `${cursors}.lock`,
    async () => {
      await atomicWrite(cursors, `${JSON.stringify(change(loadCursors(m)), null, 2)}\n`);
    },
    'chat cursors',
  );
}
