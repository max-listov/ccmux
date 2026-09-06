/**
 * The status-line tee as its own program.
 *
 * Claude Code runs the injected statusLine command on every refresh and waits for its output, so
 * this is the hottest process in the fleet — and through the full CLI bundle it spent 81 ms of CPU
 * to do 4 ms of work, because Bun parses the whole bundle before the first line of the command
 * runs. Compiled on its own it costs 36 ms, of which 25 is Bun's own start: the floor, not our code.
 *
 * It stays an ENTRY and nothing else. The command lives where it always did, so there is one
 * implementation and one place to change it; this file only says which one to run.
 */
import { cmdStatusLine } from './statusLine.ts';

process.exitCode = await cmdStatusLine();
