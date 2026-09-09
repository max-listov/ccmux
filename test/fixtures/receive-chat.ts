import { cmdReceiveChat } from '../../src/commands/receiveChat.ts';

process.exit(await cmdReceiveChat(true, await Bun.stdin.text()));
