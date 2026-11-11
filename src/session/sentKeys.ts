import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MachineConfig } from '../types.ts';
import { appendJsonl, readJsonl } from '../util/jsonl.ts';

/**
 * What `ccmux send` typed into a session's pane, kept so it can be told apart afterwards.
 *
 * Keys sent to a pane arrive in the conversation exactly as if a person had typed them: the provider
 * records a user message and nothing in it says who pressed the keys. A reader that asks "did a
 * person send this" would otherwise be told yes for any text an agent chose to type. So each send
 * leaves a line here — whose pane, a digest of the text, when, and who ran the command — and a
 * message whose text was typed by ccmux is answered as that.
 *
 * A digest, not the text: this is a record of the fact, and the words already lie in the
 * conversation.
 */
export interface SentKeys {
  session: string;
  digest: string;
  /** Epoch milliseconds. */
  at: number;
  /** Who ran the send: a session's fleet address, or `cli` for a caller that is not a session. */
  by: string;
}

const sentKeysPath = (m: MachineConfig): string => join(m.stateDir, 'sent-keys.jsonl');

/** Compared without the edges: a composer does not keep the whitespace a text was typed with. */
export const keysDigest = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex');

export function recordSentKeys(m: MachineConfig, session: string, text: string, by: string): void {
  try {
    appendJsonl(sentKeysPath(m), {
      session,
      digest: keysDigest(text),
      ts: new Date().toISOString(),
      by,
    });
  } catch {
    // The keys are already in the pane; a record that could not be written must not report the
    // send as failed. The message is then answered as nobody's, which is what is known.
  }
}

const SENT_KEYS = {
  label: 'sent keys log',
  badLine: 'skip',
  decode: (raw: unknown): SentKeys | undefined => {
    if (raw === null || typeof raw !== 'object') return undefined;
    const row = raw as Record<string, unknown>;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
    return typeof row.session === 'string' &&
      typeof row.digest === 'string' &&
      typeof row.by === 'string' &&
      Number.isFinite(at)
      ? { session: row.session, digest: row.digest, at, by: row.by }
      : undefined;
  },
} as const;

export function sentKeysOf(m: MachineConfig, session: string): SentKeys[] {
  return readJsonl(sentKeysPath(m), SENT_KEYS).filter((row) => row.session === session);
}
