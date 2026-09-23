import { z } from 'zod';
import { AttachmentReferencesSchema } from '../attachments/reference.ts';
import { AcceptedTurnOptionsSchema } from '../runtime/selectionSchema.ts';
import { CommunicationAuthorizationSchema } from './communicationAuthorizationSchema.ts';
import { CommunicationReceiptSchema } from './communicationReceiptSchema.ts';
import { ChatPrincipalSchema, ChatTargetSchema } from './identitySchema.ts';
import { MessageOriginSchema, NotificationAudienceSchema } from './originSchema.ts';

/*
 * The chat ledger envelope and the delivery cursors. Every persisted or remote shape has one
 * schema; its type is `z.infer` of it.
 */

/** One immutable v2 chat envelope. `task` is an optional pointer so the channel stays a phone call
 * (details live in the task). There are deliberately no defaults: mixed/old wire shapes fail. */
/**
 * Generation of the chat record format. It lives IN the record, not in a file name: a reader can
 * then refuse a foreign record by name ("generation 1, this build reads 2") instead of complaining
 * about a field shape — and the files keep canonical names across every future generation. Encoding
 * it in the filename instead was the mistake this replaces: `chat-v2.jsonl` is a lie the moment
 * there is a 3, and it puts a dead archive right beside live state under a near-identical name.
 */
export const CHAT_GENERATION = 2;

export const ChatMessageSchema = z
  .object({
    // First field on the remote transport and on disk, so a foreign record is identified before anything else is
    // interpreted. `.strict()` below would already reject an older record — but on the shape of
    // `from`, which reads as a bug rather than as "this is from another generation".
    v: z.literal(CHAT_GENERATION),
    id: z.uuid(), // unique per message
    ts: z.string(), // ISO-8601 send time
    from: ChatPrincipalSchema,
    to: ChatTargetSchema,
    origin: MessageOriginSchema.optional(),
    // Historical records have no claim. New external admission enforces the required input.
    communicationAuthorization: CommunicationAuthorizationSchema.optional(),
    communicationReceipt: CommunicationReceiptSchema.optional(),
    notification: NotificationAudienceSchema.optional(),
    registrationGeneration: z.uuid().optional(),
    body: z.string(),
    task: z.string().nullable(),
    // Deferred delivery: hold until the recipient VOLUNTARILY finishes its turn — delivered by the
    // Stop hook at end-of-turn, or by the daemon once the target is STABLY idle. Never pasted while
    // the target is working (Claude's steering queue would flush it mid-turn — the whole bug this
    // fixes). False means normal peer-chat behavior.
    defer: z.boolean(),
    // Relay claim supplied by an authorized courier. It does not independently authenticate the
    // claimed author or grant execution authority; `from` remains the actual ingress principal.
    onBehalfOf: z.string().nullable(),
    // Time-delayed delivery: an ISO-8601 instant before which the daemon must NOT deliver this message
    // (skipped while now < notBefore). Powers a router's self-`watchdog` (`msg <self> --after N`) so it
    // wakes on a TIMER, not only on an inbound reply — the backbone of "the router finishes the job on
    // its own". Null → deliver as soon as eligible. A defer message can also carry notBefore (both must
    // hold). `defer || notBefore !== null` makes a message CONDITIONAL — delivered by id, off the
    // in-order cursor, so it never head-of-line-blocks immediate mail.
    notBefore: z.string().nullable(),
    turnOptions: AcceptedTurnOptionsSchema.optional(),
    images: AttachmentReferencesSchema.optional(),
    controlFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

/** Delivery/read bookkeeping, kept OUT of the append-only ledger. `read[managedPeerKey]` = the ledger
 *  LENGTH a recipient has read its inbox up to (unread = TO-me messages at/after that index).
 *  Grows with delivery sinks (pane/telegram) in later phases; the daemon is the single writer. */
export const ChatCursorsSchema = z.object({
  read: z.record(z.string(), z.number()).default({}),
  // per-recipient: ledger LENGTH the daemon has PUSH-delivered a session's inbox up to. Distinct
  // from `read` (advanced by `ccmux inbox` too) so a push and a manual pull don't double-count.
  // The daemon is the sole writer; survives restarts so a bounce never re-pushes old messages.
  delivered: z.record(z.string(), z.number()).default({}),
  // A pane injection is not yet a turn. Hookless providers keep the exact message here until its
  // immutable id appears as a user record in the transcript; `wait` cannot reuse an older answer.
  pickups: z
    .record(
      z.string(),
      z
        .object({
          messageId: z.uuid(),
          injectedAt: z.iso.datetime(),
          // Stored in the same atomic cursor write as the pickup intent. An immediate cursor therefore
          // cannot hide a submitted turn without leaving the exact transcript barrier behind.
          ledgerIndex: z.number().int().nonnegative().nullable().default(null),
          conditional: z.boolean().default(false),
          // The transcript's line count when the letter was injected. Pickup is proved by reading
          // from here; a record without it is read from the first line.
          transcriptLine: z.number().int().nonnegative().optional(),
          native: z
            .object({
              phase: z.enum(['intent', 'accepted']),
              turnId: z.string().min(1).max(256).nullable(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .default({}),
  // Telegram progress: ledger LENGTH consumed (sent, permanently refused or deliberately suppressed).
  // Persisted so a restart considers only the remaining backlog, never the whole history.
  // `null` = the mirror has never run on this machine. Distinct from 0 on purpose: turning the
  // mirror ON must start a LIVE FEED, not replay the machine's whole history into the chat. (Learned
  // the hard way: enabling it on two servers instantly re-sent 25 old messages, because every
  // message ever written was, technically, "not yet mirrored".) Existing files hold a number and are
  // unaffected.
  telegram: z.number().nullable().default(null),
});

// ─────────────────────────────────────────────────────────────────────────────
// `transcript --json` — normalized view of Claude's raw JSONL conversation log.
// Each content item becomes one message (text / tool_call / tool_result / thinking).
// Reused as `lastMessage` in `list --json` ("where the session stopped").
// ─────────────────────────────────────────────────────────────────────────────
