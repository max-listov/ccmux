/**
 * `_peer-read` as its own program (`boot/routedPrograms.ts`).
 *
 * Another machine runs it on every fleet read, and through the full CLI bundle most of its CPU was
 * Bun parsing that bundle before the relay's first line. It stays an ENTRY and nothing else: the
 * command lives in `peerRead.ts`, one implementation for both ways of running it.
 */
import { cmdPeerRead } from './peerRead.ts';

// The shim runs `bun peer-read.js _peer-read <args>`: the verb is argv[2], its arguments follow.
process.exitCode = await cmdPeerRead(process.argv.slice(3));
