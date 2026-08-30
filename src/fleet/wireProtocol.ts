import { z } from 'zod';
import type { RemoteResult } from './transport.ts';

export const DOOR_API_VERSION = 2;
const VersionSchema = z.object({ v: z.int() });
/** Required door2 fields, with additive keys stripped. No private SDK is needed by this reader. */
export const WireResultSchema = z
  .object({
    v: z.literal(DOOR_API_VERSION),
    id: z.uuid(),
    ts: z.string().max(64),
    from: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    code: z.int(),
    stdout: z.string().max(4 * 1024 * 1024),
    stderr: z.string().max(4 * 1024 * 1024),
    failure: z.enum(['none', 'offline', 'denied', 'timeout', 'rejected', 'exec', 'transport']),
    refusal: z.enum(['none', 'policy', 'capacity', 'request']),
    retryAfterMs: z.int().min(0).max(3_600_000).nullable(),
    detail: z.string().max(4_096),
    truncated: z.boolean(),
  })
  .refine((value) => value.refusal === 'none' || value.failure !== 'none')
  .refine((value) => value.retryAfterMs === null || value.refusal === 'capacity');

export function refusalIsPermanent(refusal: z.infer<typeof WireResultSchema>['refusal']) {
  if (refusal === 'none') return undefined;
  return refusal !== 'capacity';
}

export function readWireResult(value: unknown): RemoteResult {
  const version = VersionSchema.safeParse(value);
  if (version.success && version.data.v !== DOOR_API_VERSION)
    return {
      code: 1,
      stdout: '',
      stderr: '',
      transportFailed: true,
      delivery: 'unknown',
      permanent: true,
      failureDetail: `the local stitchwire agent speaks door API v${version.data.v}, this ccmux understands v${DOOR_API_VERSION}`,
    };
  const result = WireResultSchema.safeParse(value);
  if (!result.success)
    return {
      code: 1,
      stdout: '',
      stderr: '',
      transportFailed: true,
      delivery: 'unknown',
      failureDetail: 'stitchwire agent returned an unreadable result',
    };
  const parsed = result.data;
  if (parsed.failure !== 'none') {
    const permanent = refusalIsPermanent(parsed.refusal);
    return {
      code: 1,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      transportFailed: true,
      delivery:
        parsed.failure === 'timeout' || parsed.failure === 'transport'
          ? 'unknown'
          : parsed.failure === 'exec'
            ? 'received'
            : 'not-sent',
      failureDetail: `${parsed.failure}${parsed.refusal === 'none' ? '' : `/${parsed.refusal}`}: ${parsed.detail}`,
      ...(permanent === undefined ? {} : { permanent }),
      ...(parsed.retryAfterMs === null ? {} : { retryAfterMs: parsed.retryAfterMs }),
    };
  }
  return {
    code: parsed.code,
    stdout: parsed.stdout,
    stderr: parsed.truncated
      ? `${parsed.stderr}\n[wire] output truncated at the stream cap\n`
      : parsed.stderr,
    transportFailed: false,
    delivery: 'received',
  };
}
