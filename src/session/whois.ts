import { conversationTitle } from '../agent/claude/fork.ts';
import { RC_PREFIX_RE, SESSION_NAME_RE } from '../chat/identitySchema.ts';
import { storedDir } from '../context/corpusSearch.ts';
import { storedConversations } from '../context/storedConversations.ts';
import type { MachineConfig, Session } from '../types.ts';
import { type IdentityCache, sessionIdentities } from './identity.ts';
import type {
  SessionIdentity,
  StrayConversation,
  WhoisAnswer,
  WhoisCandidate,
  WhoisMachine,
} from './identitySchema.ts';
import { loadSessions } from './registry.ts';
import { repositoryOf } from './repository.ts';

/**
 * "Which session is this?" — asked with whatever name of it the asker happened to see.
 *
 * A program outside ccmux meets a session by one of three names: the title its window shows, the id
 * the provider gave its conversation, or its address. Each is matched exactly. A title is compared
 * word by word with the title a session is launched under, so a window that merely resembles one —
 * a longer name, a shared prefix — is not a session: the nearest name is a different session, and
 * work filed under it is filed wrongly without anything looking wrong.
 */
export type WhoisQuestion =
  | { kind: 'conversation'; id: string }
  | { kind: 'address'; machine: string; name: string }
  | { kind: 'words'; words: string[] };

const CONVERSATION_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_\w+)$/i;

export function readQuestion(text: string): WhoisQuestion {
  const query = text.trim();
  if (CONVERSATION_ID.test(query)) return { kind: 'conversation', id: query.toLowerCase() };
  const colon = query.indexOf(':');
  const machine = query.slice(0, colon);
  const name = query.slice(colon + 1);
  if (colon > 0 && RC_PREFIX_RE.test(machine) && SESSION_NAME_RE.test(name))
    return { kind: 'address', machine, name };
  return { kind: 'words', words: query.split(/\s+/).filter((word) => word !== '') };
}

/** The machine a question names, when it names one: nobody else can answer it. */
export function machineAsked(question: WhoisQuestion): string | null {
  return question.kind === 'address' ? question.machine : null;
}

export function matchSessions(
  m: MachineConfig,
  question: WhoisQuestion,
  identities: readonly SessionIdentity[],
): WhoisCandidate[] {
  const out: WhoisCandidate[] = [];
  for (const session of identities) {
    if (question.kind === 'conversation') {
      if (session.conversations.some((life) => life.id.toLowerCase() === question.id))
        out.push({ by: 'conversation', session });
    } else if (question.kind === 'address') {
      if (question.machine === m.rcPrefix && question.name === session.name)
        out.push({ by: 'address', session });
    } else if (question.words.length === 1 && question.words[0] === session.name) {
      out.push({ by: 'address', session });
    } else if (question.words.includes(session.title)) {
      out.push({ by: 'title', session });
    }
  }
  return out;
}

/** A provider id that no session answers for: the conversation itself, if this machine keeps it. */
export async function strayConversation(
  m: MachineConfig,
  id: string,
  sessions: readonly Session[],
): Promise<StrayConversation | null> {
  const stored = storedConversations(m, sessions).find(
    (conversation) => conversation.threadId.toLowerCase() === id,
  );
  const file = stored?.files.at(-1);
  if (stored === undefined || file === undefined) return null;
  const dir = stored.dir ?? (await storedDir(file));
  return {
    provider: stored.provider,
    id: stored.threadId,
    machine: m.rcPrefix,
    address: stored.address,
    title: stored.provider === 'claude' ? conversationTitle(file.path) : null,
    dir,
    repository: await repositoryOf(dir),
  };
}

export interface MachineWhois {
  candidates: WhoisCandidate[];
  conversation: StrayConversation | null;
}

export async function whoisHere(
  m: MachineConfig,
  question: WhoisQuestion,
  sessions: readonly Session[] = loadSessions(m),
  cache?: IdentityCache,
): Promise<MachineWhois> {
  const candidates = matchSessions(m, question, await sessionIdentities(m, sessions, cache));
  const conversation =
    candidates.length === 0 && question.kind === 'conversation'
      ? await strayConversation(m, question.id, sessions)
      : null;
  return { candidates, conversation };
}

/** One answer from what every asked machine found. Several sessions are never narrowed to one. */
export function settleWhois(
  query: string,
  parts: readonly MachineWhois[],
  machines: WhoisMachine[],
): WhoisAnswer {
  const candidates = parts.flatMap((part) => part.candidates);
  const only = candidates.length === 1 ? (candidates[0] as WhoisCandidate) : null;
  const conversation =
    candidates.length === 0
      ? (parts.find((part) => part.conversation)?.conversation ?? null)
      : null;
  return {
    query,
    found:
      only !== null
        ? 'session'
        : candidates.length > 1
          ? 'ambiguous'
          : conversation !== null
            ? 'conversation'
            : 'none',
    by: only?.by ?? (conversation !== null ? 'conversation' : null),
    session: only?.session ?? null,
    conversation,
    candidates,
    machines,
  };
}
