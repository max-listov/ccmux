import { z } from 'zod';
import { AgentKindSchema, RC_PREFIX_RE, SESSION_NAME_RE } from '../chat/identitySchema.ts';

/*
 * The session event feed and the inventory it carries. Every persisted or remote shape has one
 * schema; its type is `z.infer` of it.
 */

// ─────────────────────────────────────────────────────────────────────────────
/**
 * One session event: a TRANSITION, not a state.
 *
 * The distinction is the whole reason this exists. Every outside surface used to learn about
 * sessions by polling `list --json`, which answers "what is true now" — so a turn that started and
 * ended between two polls left no trace, and "this ran for thirty minutes" could not be recovered
 * from two snapshots. A feed of transitions answers that directly, and costs nothing while nothing
 * happens.
 *
 * `id` is the idempotency key, and it is load-bearing rather than decorative: delivery here is
 * at-least-once by construction (a reader reconnecting with `--since` re-reads the boundary, and two
 * writers append independently), so a consumer that ACTS on an event — speaks it, blinks a light —
 * must be able to recognise one it has already handled.
 */
export const SessionEventKindSchema = z.enum([
  'turn-start',
  'turn-end',
  // A session sitting at a blocking menu, and the moment it leaves one. `resumed` exists because the
  // pair is not otherwise closable: answering a permission prompt puts the agent straight back to
  // work WITHOUT a new user turn, so nothing else would ever follow the `waiting`. A reader tracking
  // state would leave that session marked "waiting for you" until its next turn — which can be
  // hours, and reads as a session that needs attention when it needs none.
  'waiting',
  'resumed',
  'session-start',
  'session-stop',
  'session-blocked',
  // One session's inventory row changed, appeared or left; see `events/inventory.ts`.
  'inventory',
]);

export const SESSION_EVENT_VERSION = 1;

/**
 * One session as the daemon's observation pass last saw it — only what changes at the pace of the
 * session's own life. Read leniently: rows cross machines on mixed builds.
 */
export const InventoryRowSchema = z
  .object({
    name: z.string().min(1),
    agent: AgentKindSchema,
    uuid: z.uuid(),
    address: z.string().min(1),
    archived: z.boolean(),
    running: z.boolean(),
    /** The monitoring vocabulary: working, idle, prompt, stopped, blocked, unknown. */
    state: z.string().min(1),
    model: z.string().nullable(),
    contextPercent: z.number().int().min(0).max(100).nullable(),
    /** When the session's tmux session was created; a reader derives uptime from its own clock. */
    startedAt: z.iso.datetime().nullable(),
    turnStartedAt: z.iso.datetime().nullable(),
    /** The last transcript entry's shape — never its text. Null when not running or unknown. */
    step: z
      .object({
        kind: z.string(),
        role: z.string(),
        toolName: z.string().nullable(),
        at: z.string().nullable(),
      })
      .loose()
      .nullable(),
  })
  .loose();
export type InventoryRow = z.infer<typeof InventoryRowSchema>;

/** Where an inventory stands: the daemon run that owns it and how many changes it has made. */
export const InventoryRevisionSchema = z.object({
  generation: z.uuid(),
  sequence: z.number().int().nonnegative(),
});

export const InventorySnapshotSchema = InventoryRevisionSchema.extend({
  pid: z.number().int().positive(),
  sessions: z.array(InventoryRowSchema),
}).loose();
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;

export const SessionEventSchema = z
  .object({
    v: z.number().int().positive(),
    id: z.uuid(),
    ts: z.iso.datetime(),
    // The full address, so a reader never has to resolve anything against its own machine — the
    // mistake fleet addressing exists to remove.
    machine: z.string().regex(RC_PREFIX_RE),
    session: z.string().min(1).regex(SESSION_NAME_RE),
    agent: AgentKindSchema,
    threadId: z.uuid(),
    event: SessionEventKindSchema,
    /** `turn-end` only: how long the turn ran, when its start was observed. */
    durationMs: z.number().nonnegative().optional(),
    /** `turn-end` only: the turn did NOT end voluntarily (interrupted, or the agent died). The hook
     *  never fires for those, so this can only ever come from the supervisor's own observation. */
    interrupted: z.boolean().optional(),
    /** Free-form context for the kinds that have any: which menu a session waits at, why it is
     *  blocked. Never conversation content — that stays in the transcript, behind its own command. */
    detail: z.string().optional(),
    /** `inventory` only: the revision this change produces — the next sequence of its generation. */
    inventory: InventoryRevisionSchema.optional(),
    /** `inventory` only: the session's row after the change; null when it left the inventory. */
    row: InventoryRowSchema.nullable().optional(),
  })
  // NOT strict, and that is the point: this record is read by other machines and by outside
  // surfaces, which may be running an older build than the one that wrote it. Strict parsing would
  // turn "a newer ccmux added a field" into "every event after the upgrade is unreadable here" —
  // a fleet-wide silence produced by a version skew nobody would think to check. Unknown keys ride
  // through untouched, so an old `ccmux events --json` still hands a consumer a field only the
  // newer writer understands. Same leniency the fleet's own `list --json` adapter already applies
  // to a peer's answer.
  .loose();

// `list --json` transport shape — the canonical machine-readable contract that
// dashboards/agents (and our own TUI) consume. Decoupled from any downstream
// consumer's own snapshot type ON PURPOSE: duplicated there, never
// cross-imported, so the two evolve independently.
// ─────────────────────────────────────────────────────────────────────────────
