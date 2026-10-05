import { createClient } from 'stitchkit';
import { externalListContract } from '../control/schema/externalList.ts';
import { createControlConnection } from '../control/transport/connection.ts';
import { writeOut } from '../util/stdout.ts';

/** The session identity a control call presents: the one the managed launch handed this process. */
export function controlIdentity(): { session?: string; credential?: string } {
  return {
    ...(process.env.CCMUX_SESSION ? { session: process.env.CCMUX_SESSION } : {}),
    ...(process.env.CCMUX_CHAT_CREDENTIAL ? { credential: process.env.CCMUX_CHAT_CREDENTIAL } : {}),
  };
}

/**
 * `control external --json`: the same endpoint and credentials as the full control command, without
 * loading its other operations. The full CLI and the routed relay both run exactly this.
 */
export async function runControlExternal(): Promise<number> {
  const connection = createControlConnection(controlIdentity());
  try {
    const answer = await createClient(externalListContract, connection.http)['external.list']();
    await writeOut(`${JSON.stringify(answer)}\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await connection.close();
  }
}
