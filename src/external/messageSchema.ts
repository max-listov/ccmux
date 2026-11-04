import { z } from 'zod';
import { ExternalContentTargetSchema } from './contentSchema.ts';

export const EXTERNAL_MESSAGE_LIMITS = {
  /** One file is streamed in constant memory, so the bound is time: about 1.3 GB/s measured on a
   *  213 MB history, inside the six-second read deadline. A long Desktop thread's live file passes
   *  1 GB before it is split. */
  sourceBytes: 2 * 1024 * 1024 * 1024,
  /** One native record holding the message, images included, is parsed whole up to this size. */
  recordBytes: 4 * 1024 * 1024,
  /** The message text is returned whole or not at all; past this it is `too-large`. */
  textBytes: 256 * 1024,
  /** Turns whose trigger is remembered while the source is scanned. */
  turns: 100_000,
};

export const ExternalMessageReadSchema = z
  .object({ target: ExternalContentTargetSchema, messageId: z.uuid() })
  .strict();

/**
 * What the thread's own native history says about who submitted an input.
 * `person`: the turn it opened was started by a person in the provider's own client (its composer, a
 * phone, an edit of an earlier message) — the person sent it, which says nothing about who wrote the
 * text: pasted material is still sent by the person. `not-person`: an agent, an automation or the
 * client itself started that turn. `unverifiable`: the history does not say — a message added to a
 * turn already running, a turn with no recorded trigger, or a trigger that does not identify a sender.
 */
export const ExternalMessageAuthorshipSchema = z
  .object({
    verdict: z.enum(['person', 'not-person', 'unverifiable']),
    trigger: z.string().max(64).nullable(),
    position: z.enum(['turn-opening', 'mid-turn']),
    reason: z.string().max(256),
  })
  .strict();

export const ExternalMessageSchema = z
  .object({
    id: z.uuid(),
    clientId: z.string().max(128).nullable(),
    turnId: z.string().max(128),
    recordedAt: z.iso.datetime().nullable(),
    /** Every text part of the native message, concatenated in order with nothing added. */
    text: z.string(),
    images: z.number().int().nonnegative(),
    authorship: ExternalMessageAuthorshipSchema,
  })
  .strict();

/**
 * `resolved`: the exact native message, whole. `not-found`: this thread's history has no item with
 * that id. `not-user-input`: the id names an item that is not user input (an assistant message, a
 * tool call). `ambiguous`: two different records carry the id. `too-large`: the record or its text
 * exceeds the bounds and is not returned cut. `unsupported`: the provider or this history's format
 * records no native message identities. `history-absent`: no history for the thread on this host.
 * `unavailable`: the history could not be read.
 */
export const ExternalMessageOutcomeSchema = z.enum([
  'resolved',
  'not-found',
  'not-user-input',
  'ambiguous',
  'too-large',
  'unsupported',
  'history-absent',
  'unavailable',
]);

export const ExternalMessageResultSchema = z
  .object({
    target: ExternalContentTargetSchema,
    messageId: z.uuid(),
    outcome: ExternalMessageOutcomeSchema,
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    observedAt: z.iso.datetime(),
    message: ExternalMessageSchema.nullable(),
  })
  .strict();

export type ExternalMessageRead = z.input<typeof ExternalMessageReadSchema>;
export type ExternalMessageResult = z.output<typeof ExternalMessageResultSchema>;
export type ExternalMessageAuthorship = z.output<typeof ExternalMessageAuthorshipSchema>;
