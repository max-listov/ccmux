import { cmdReceiveChat } from '../../src/commands/msg.ts';

process.exit(await cmdReceiveChat(true, await Bun.stdin.text()));
