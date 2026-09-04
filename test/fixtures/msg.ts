import type { RemoteTransport } from '../../src/chat/auth.ts';
import { cmdMsg } from '../../src/commands/msg.ts';

const requested = process.env.CCMUX_TEST_REMOTE_TRANSPORT;
const transport: RemoteTransport | null =
  requested === 'ssh' || requested === 'remote' ? requested : null;

process.exitCode = await cmdMsg(process.argv.slice(2), transport);
