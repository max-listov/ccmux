import { z } from 'zod';
import { AgentKindSchema, RC_PREFIX_RE, SESSION_NAME_RE } from '../chat/identitySchema.ts';

/*
 * Who a session IS, for a program that only saw one of its names: the title of a window, the id a
 * provider gave its conversation, or its address. The same shape answers one question, lists the
 * fleet and travels in the live stream, so a consumer reads it once.
 */

/**
 * The project a directory's repository says it belongs to. Described in the schema itself: a
 * consumer that reads by `--schema` learns there what form the value has and when it is absent.
 */
export const DeclaredProjectSchema = z
  .string()
  .min(1)
  .describe(
    'The project the repository of `dir` belongs to, as repositories declare it in `.passport.json`: the `identity.project` of the checkout itself, or of a checkout in the same parent directory whose `source.repositoryId` names this repository; for a directory that holds checkouts, the one project all of them resolve to. The key exactly as written (a slug such as `acme-api`, without a slash, the same for every repository of one product). Absent when nothing declares one or the declarations disagree; never derived from the name of a repository or of a directory.',
  );

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
  project: DeclaredProjectSchema.optional(),
  checkouts: z
    .array(
      z.object({
        dir: z.string().startsWith('/'),
        repository: z.string().nullable(),
        role: z
          .string()
          .min(1)
          .describe(
            'The role the checkout declares (`identity.role`); failing that `private-workspace` for one that names the source it is the working half of, and `source` for any other.',
          ),
        current: z.boolean().describe("The session's directory is in this checkout."),
      }),
    )
    .optional()
    .describe(
      "The checkouts of the session's project on its machine: those in one directory — beside the session's own checkout, or inside the folder it was opened on — that resolve to the same `project`. Where a product's private working half is, it holds the task queue and the working rules. Present with `project`.",
    ),
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
  project: DeclaredProjectSchema.optional(),
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
 * One line of `whois --follow`. `session` is a session as it now is — sent once for each when its
 * machine first answers, and again whenever anything but its activity times changes; `gone` is a
 * session that left its machine's registry; `machine` says a machine has been read, or that it was
 * not and why — its sessions are then not known to be gone.
 */
export const WhoisEventSchema = z.union([
  z.object({ event: z.literal('session'), session: SessionIdentitySchema }),
  // A machine as the follower last found it: after the first, each time that changes.
  ...WhoisMachineSchema.options.map((standing) =>
    standing
      .extend({ event: z.literal('machine') })
      .describe(
        'A machine as the follower last found it: sent after the first `session` lines of that machine, and again each time its status or the reason changes. The sessions of an unavailable machine are not known to be gone.',
      ),
  ),
  z.object({
    event: z.literal('gone'),
    address: z.string().min(1),
    machine: z.string().regex(RC_PREFIX_RE),
    name: z.string().regex(SESSION_NAME_RE),
  }),
]);
export type WhoisEvent = z.infer<typeof WhoisEventSchema>;
