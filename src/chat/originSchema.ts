import { z } from 'zod';

const TokenSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const AttributedActorSchema = z.enum(['human', 'agent', 'application']);
export const MessageAttributionSchema = z
  .object({
    applicationId: TokenSchema,
    channelId: TokenSchema,
    actor: AttributedActorSchema,
  })
  .strict();
export const MessageApplicationsSchema = z
  .record(
    TokenSchema,
    z
      .object({
        revision: TokenSchema,
        callers: z.array(TokenSchema).min(1).max(64),
        channels: z.array(TokenSchema).min(1).max(64),
        actors: z.array(AttributedActorSchema).min(1).max(3),
        ownerNotifications: z.boolean().default(false),
      })
      .strict(),
  )
  .default({});
export const MessageOriginSchema = z
  .object({
    ingress: z.enum(['cli', 'local-control', 'service', 'managed', 'codex-app', 'unknown']),
    actor: z.enum(['human', 'agent', 'application', 'unknown']),
    assurance: z.enum(['runtime-identity', 'application-attested', 'unknown']),
    application: MessageAttributionSchema.extend({
      revision: TokenSchema,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
      .strict()
      .nullable(),
  })
  .strict();
export const NotificationAudienceSchema = z.enum(['conversation', 'owner']);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;
export type MessageAttribution = z.infer<typeof MessageAttributionSchema>;
export type NotificationAudience = z.infer<typeof NotificationAudienceSchema>;

/** Missing historical evidence is not permission to infer an author or notify a human. */
export function unknownMessageOrigin(): MessageOrigin {
  return { ingress: 'unknown', actor: 'unknown', assurance: 'unknown', application: null };
}
