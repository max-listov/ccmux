import type { AgentProvider } from '../agent/index.ts';
import type { MachineConfig, Session } from '../types.ts';
import { conversationSeen, markConversationSeen } from './conversationSeen.ts';

/** Only a conversation that was seen or found elsewhere needs protecting. An incomplete search
 *  cannot establish a first launch, and must not create new history over an unreadable one. */
export function conversationVerdict(f: {
  present: boolean;
  found: string | null;
  seen: boolean;
  searchComplete: boolean;
}): 'start' | 'block' {
  if (f.present) return 'start';
  return f.found !== null || f.seen || !f.searchComplete ? 'block' : 'start';
}

/** Records observed history, or returns the launch refusal with the exact scope of its search. */
export function missingConversation(
  m: MachineConfig,
  s: Session,
  provider: AgentProvider,
  present: boolean,
  expected: string | null,
): string | null {
  if (present) {
    markConversationSeen(s.name, s.uuid);
    return null;
  }
  const search = provider.findHistoryElsewhere?.(s, m);
  const found = search?.found ?? null;
  const seen = conversationSeen(s.name, s.uuid);
  const searchComplete = search === undefined || search.failures.length === 0;
  if (conversationVerdict({ present, found, seen, searchComplete }) === 'start') return null;
  const where = found === null ? '' : ` — it is at ${found}`;
  const scope = search === undefined ? '' : ` Searched projects roots: ${search.roots.join(', ')}.`;
  const failures = searchComplete
    ? ''
    : ` Search incomplete: ${search?.failures.map((f) => `${f.path}: ${f.reason}`).join('; ')}.`;
  const reason = !searchComplete
    ? `${s.name} cannot verify conversation ${s.uuid} at ${expected ?? 'its expected path'}${where}`
    : `${s.name} has a conversation ${s.uuid}, but it is missing at ${expected ?? 'its expected path'}${where}`;
  return (
    `${reason}.${scope}${failures} Refusing to start a NEW conversation on top of it. ` +
    `If it can be recovered (the project directory or the session's profile moved?), put it where this session now points, then: ccmux start ${s.name}   ·   ` +
    `If it is gone for good: ccmux renew ${s.name}   — a fresh conversation for this session, keeping its dir, mode, chat and prompt modules`
  );
}
