import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceDeclaration } from '@stitchwire/client/contracts';

/**
 * A caller of the daemon's declared `stitchmux.control` service in tests, reaching it the one way a
 * caller from another machine can: the Stitchwire node posts an envelope naming the operation and
 * the node-authenticated caller to `/invoke`, and the daemon's ingress dispatches it if the
 * operator's grants allow. There is no header that makes a request a service call.
 */

/** The machine fields that make `createControlServer` own the service, rooted in `directory`. */
export function declaredServiceConfig(directory: string) {
  return {
    remoteTransport: {
      kind: 'stitchwire' as const,
      peers: [] as string[],
      serviceDirectory: directory,
    },
  };
}

/** Write the operator's grants the service reads on `start()`/`refresh()`. */
export function grantCallers(directory: string, callers: ServiceDeclaration['callers']): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'stitchmux.control.callers.json'), JSON.stringify(callers), {
    mode: 0o600,
  });
}

export { declaredServiceFetch } from '../scripts/control-client.ts';
