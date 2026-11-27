import { createWireClient, WireClientError } from '@stitchwire/client';
import type { RemoteTransportRequest } from './remoteTransportContract.ts';
import type { RemoteResult } from './transport.ts';

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
    const delivery =
      failure === 'exec'
        ? 'received'
        : ['timeout', 'transport', 'cancelled'].includes(failure)
          ? 'unknown'
          : 'not-sent';
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
