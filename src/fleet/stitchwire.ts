import { createWireClient, WireClientError } from '@stitchwire/client';
import type { RemoteResult } from './transport.ts';

/** One command for another machine: its argv, optional stdin and how long the far side may take. */
export interface RemoteTransportRequest {
  readonly to: string;
  readonly argv: string[];
  readonly stdin: string | null;
  readonly timeoutMs: number;
}

type WireFailure = Exclude<
  Awaited<ReturnType<ReturnType<typeof createWireClient>['call']>>['failure'],
  'none'
>;

/**
 * Whether a failed call reached the far side. `not-sent` licenses a retry of a mutation, so only a
 * failure that by its definition stopped before dispatch earns it; the switch is exhaustive over
 * Stitchwire's vocabulary, and a failure kind added there fails this module's typecheck instead of
 * silently becoming "safe to retry".
 */
export function deliveryOf(failure: WireFailure): RemoteResult['delivery'] {
  switch (failure) {
    case 'exec':
      return 'received';
    case 'timeout':
    case 'transport':
    case 'cancelled':
      return 'unknown';
    case 'offline':
    case 'denied':
    case 'rejected':
      return 'not-sent';
    default:
      failure satisfies never;
      return 'unknown';
  }
}

/** Preserve the remote execution verdict and distinguish an uncertain delivery from a safe retry. */
export async function callStitchwire(
  socketPath: string,
  request: RemoteTransportRequest,
  signal?: AbortSignal,
): Promise<RemoteResult> {
  const wire = createWireClient({ socketPath });
  try {
    const result = await wire.call(request, signal ? { signal } : {});
    if (result.failure === 'none') {
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.truncated
          ? `${result.stderr}\n[remote transport] output truncated at the provider cap\n`
          : result.stderr,
        transportFailed: false,
        delivery: 'received',
      };
    }
    const { failure, refusal, detail, retryAfterMs } = result;
    const delivery = deliveryOf(failure);
    return {
      code: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      transportFailed: true,
      delivery,
      failureDetail: `${failure}${refusal === 'none' ? '' : `/${refusal}`}: ${detail}`,
      ...(refusal === 'none'
        ? failure === 'denied'
          ? { permanent: true }
          : {}
        : { permanent: refusal !== 'capacity' }),
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    };
  } catch (error) {
    const known = error instanceof WireClientError;
    return {
      code: 1,
      stdout: '',
      stderr: '',
      transportFailed: true,
      delivery: known ? error.delivery : 'unknown',
      failureDetail: known
        ? `Stitchwire ${error.code}: ${error.message}`
        : 'Stitchwire returned no complete result',
      ...(known && ['permission', 'invalid-request', 'unsupported', 'version'].includes(error.code)
        ? { permanent: true }
        : {}),
    };
  } finally {
    wire.close();
  }
}
