import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';
import { RC_PREFIX_RE } from '../config/schema.ts';

const RemoteTransportDeliverySchema = z.enum(['not-sent', 'unknown', 'received']);

/** Provider-neutral command transport. Implementations own their protocol and credentials. */
export const RemoteTransportRequestSchema = z
  .object({
    to: z.string().regex(RC_PREFIX_RE),
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(64 * 1024),
      )
      .min(1)
      .max(256),
    stdin: z
      .string()
      .max(8 * 1024 * 1024)
      .nullable(),
    timeoutMs: z.number().int().min(1_000).max(900_000),
  })
  .strict();

export const RemoteTransportResultSchema = z
  .object({
    code: z.number().int(),
    stdout: z.string().max(52 * 1024 * 1024),
    stderr: z.string().max(52 * 1024 * 1024),
    transportFailed: z.boolean(),
    delivery: RemoteTransportDeliverySchema,
    failureDetail: z.string().max(4_096).optional(),
    permanent: z.boolean().optional(),
    retryAfterMs: z.number().int().min(0).max(3_600_000).optional(),
  })
  .strict();

export type RemoteTransportRequest = z.infer<typeof RemoteTransportRequestSchema>;
export type RemoteTransportResult = z.infer<typeof RemoteTransportResultSchema>;

export const remoteTransportContract = defineContract(
  { prefix: 'ccmux-remote-transport', scope: 'local' },
  {
    call: {
      method: 'POST',
      path: '/call',
      desc: 'Run one command through an injected remote transport',
      input: RemoteTransportRequestSchema,
      output: RemoteTransportResultSchema,
      maxJsonBodyBytes: 8 * 1024 * 1024 + 128 * 1024,
      timeout: 900_000,
    },
  },
);
