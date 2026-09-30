import { createClient } from 'stitchkit';
import { externalListContract } from '../control/schema/externalList.ts';
import { createControlConnection } from '../control/transport/connection.ts';
import { writeOut } from '../util/stdout.ts';

/** Same endpoint and credentials as the full control command, without loading other operations. */
export async function cmdControlExternal(): Promise<number> {
  const connection = createControlConnection({
    ...(process.env.CCMUX_SESSION ? { session: process.env.CCMUX_SESSION } : {}),
    ...(process.env.CCMUX_CHAT_CREDENTIAL ? { credential: process.env.CCMUX_CHAT_CREDENTIAL } : {}),
  });
  try {
    const answer = await createClient(externalListContract, connection.http)['external.list']();
    await writeOut(`${JSON.stringify(answer)}\n`);
    return 0;
  } finally {
    await connection.close();
  }
}
