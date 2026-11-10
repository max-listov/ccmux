import { z } from 'zod';
import { AgentKindSchema, RC_PREFIX_RE, SESSION_NAME_RE } from '../chat/identitySchema.ts';

/*
 * Who a session IS, for a program that only saw one of its names: the title of a window, the id a
 * provider gave its conversation, or its address. The same shape answers one question, lists the
 * fleet and travels in the live stream, so a consumer reads it once.
 */

/** One conversation a session has lived in. A session keeps its name while the provider moves it to
 *  a new id — after a `/clear`, a fork or a compaction — so the ids are a list, not a value. */
export const SessionLifeSchema = z.object({
  /** The provider's own id: a Claude Code `sessionId`, a Codex thread id. */
  id: z.string().min(1),
  /** The session reads this conversation now. Exactly one life is current. */
  current: z.boolean(),
  /** When the first and the newest record of the conversation were written; null when the file is
   *  not there to read. */
  firstAt: z.iso.datetime().nullable(),
  lastAt: z.iso.datetime().nullable(),
});
export type SessionLife = z.infer<typeof SessionLifeSchema>;

export const SessionIdentitySchema = z.object({
  /** `<machine>:<name>` — what every other ccmux command takes. */
  address: z.string().min(1),
  machine: z.string().regex(RC_PREFIX_RE),
  name: z.string().regex(SESSION_NAME_RE),
  provider: AgentKindSchema,
  /** The name the provider shows for this session — in a window title, a pane, a session list. */
  title: z.string().min(1),
  /** The registered working directory, on the session's own machine. */
  dir: z.string().startsWith('/'),
  /** `owner/name` of that directory's `origin`, or null when it has none. */
  repository: z.string().nullable(),
  archived: z.boolean(),
  /** Whether the agent is running, as the machine's daemon last observed; null without a daemon. */
  running: z.boolean().nullable(),
  /** The provider id the session reads now. */
  conversation: z.string().min(1),
  /** Every provider id this session has lived under on its machine, oldest first. Only a Claude
   *  session has more than one: the other providers keep one id for a session's whole life. */
  conversations: z.array(SessionLifeSchema).min(1),
  /** The first record of the oldest conversation, and the newest record of any. */
  createdAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
});
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

/** A conversation no managed session reads or has read: where it is, and what it calls itself. */
export const StrayConversationSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  id: z.string().min(1),
  machine: z.string().regex(RC_PREFIX_RE),
  /** What `ccmux transcript` opens it by. */
  address: z.string().min(1),
  /** The title its file opens with, when it has one — the name of a session that is gone. */
  title: z.string().nullable(),
  dir: z.string().nullable(),
  repository: z.string().nullable(),
});
export type StrayConversation = z.infer<typeof StrayConversationSchema>;

export const WhoisMachineSchema = z.union([
  z.object({ machine: z.string().min(1), status: z.literal('asked') }),
  z.object({ machine: z.string().min(1), status: z.literal('unavailable'), error: z.string() }),
]);
export type WhoisMachine = z.infer<typeof WhoisMachineSchema>;

/** How the question was matched to a session. */
export const WhoisBySchema = z.enum(['address', 'title', 'conversation']);
export type WhoisBy = z.infer<typeof WhoisBySchema>;

export const WhoisCandidateSchema = z.object({ by: WhoisBySchema, session: SessionIdentitySchema });
export type WhoisCandidate = z.infer<typeof WhoisCandidateSchema>;

/**
 * The answer to one question.
 *
 * `found` says which of the fields below carries it: `session` — exactly one managed session;
 * `conversation` — a provider id that exists on a machine but belongs to no managed session;
 * `ambiguous` — the question fits several sessions and none is chosen;
 * `none` — nothing on the machines that were asked. A machine that was not asked is in `machines`,
 * so `none` beside an unavailable machine is not "no such session". `candidates` is every session
 * the question fits, however many: one beside `session`, several beside `ambiguous`.
 */
export const WhoisAnswerSchema = z.object({
  query: z.string(),
  found: z.enum(['session', 'conversation', 'ambiguous', 'none']),
  by: WhoisBySchema.nullable(),
  session: SessionIdentitySchema.nullable(),
  conversation: StrayConversationSchema.nullable(),
  candidates: z.array(WhoisCandidateSchema),
  machines: z.array(WhoisMachineSchema),
});
export type WhoisAnswer = z.infer<typeof WhoisAnswerSchema>;

export const WhoisListSchema = z.object({
  sessions: z.array(SessionIdentitySchema),
  machines: z.array(WhoisMachineSchema),
});
export type WhoisList = z.infer<typeof WhoisListSchema>;

/**
 * One line of `whois --follow`. `session` is a session as it now is — sent once for each when the
 * stream opens, and again whenever anything but its activity times changes; `gone` is a session
 * that left the registry.
 */
export const WhoisEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('session'), session: SessionIdentitySchema }),
  z.object({
    event: z.literal('gone'),
    address: z.string().min(1),
    machine: z.string().regex(RC_PREFIX_RE),
    name: z.string().regex(SESSION_NAME_RE),
  }),
]);
export type WhoisEvent = z.infer<typeof WhoisEventSchema>;
