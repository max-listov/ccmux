import { answerPeerOperation } from '../control/peerOperation.ts';
import { createControlClient } from '../control/transport/client.ts';
import { writeOut } from '../util/stdout.ts';
import { controlIdentity } from './controlExternal.ts';

/**
 * `ccmux _peer-operation <operation>` — what another machine's daemon runs here to hand over a call
 * on one of this machine's sessions (`control/peerOperation.ts`). The input arrives on stdin; this
 * program asks this machine's daemon over the local socket and prints one line, the answer or the
 * refusal. It is not a command anyone types.
 */
export async function cmdPeerOperation(args: string[]): Promise<number> {
  const [key, ...rest] = args;
  if (key === undefined || rest.length > 0) {
    console.error('usage: ccmux _peer-operation <operation>  (the input on stdin)');
    return 2;
  }
  const raw = await Bun.stdin.text();
  const client = createControlClient(controlIdentity());
  try {
    const answer = await answerPeerOperation(key, raw, (operation, input) =>
      // The operation's own input schema validated `input` above; the client checks it again.
      (client[operation] as (value: unknown) => Promise<unknown>)(input),
    );
    await writeOut(`${JSON.stringify(answer)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}
