import type { ClientFetch } from 'stitchkit';
import { controlContract } from '../src/control/schema/contract.ts';
import { VERSION } from '../src/util/version.ts';

const operationByPath = new Map(
  Object.entries(controlContract.endpoints).map(([id, endpoint]) => [
    `/${controlContract.meta.prefix}${endpoint.path}`,
    id,
  ]),
);

/**
 * A `ClientFetch` that delivers each call of the public contract client to a daemon's declared
 * `stitchmux.control` service as `caller`, the one way a caller from another machine reaches it: an
 * envelope naming the operation and the node-authenticated caller, posted to `/invoke` on the
 * daemon's socket — what the Stitchwire node does. The daemon must own the service
 * (`remoteTransport.kind: 'stitchwire'` with a `serviceDirectory`) and grant `caller` the operation.
 */
export function declaredServiceFetch(
  socket: string,
  caller: string,
  inspect?: (value: unknown) => void,
): ClientFetch {
  return async (url, init) => {
    const path = new URL(String(url)).pathname;
    const operation = operationByPath.get(path);
    if (operation === undefined) throw new Error(`No control operation at ${path}`);
    const payload = typeof init?.body === 'string' ? init.body : '{}';
    inspect?.(payload);
    const response = await fetch('http://stitchmux.local/invoke', {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        service: 'stitchmux.control',
        revision: VERSION,
        operation,
        caller,
        payload,
      }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (inspect !== undefined) inspect(await response.clone().text());
    return response;
  };
}
