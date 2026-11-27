import { homedir } from 'node:os';

/**
 * Who and where this process is: the platform, the user and the home directory.
 *
 * Its own module so a library build (the client package, which needs the default state root) takes
 * these three without the command line's self re-exec in `env.ts`.
 */
export const PLATFORM = process.platform; // "darwin" | "linux"
export const UID = process.getuid?.() ?? 0;
export const HOME = homedir(); // never $HOME string-parse
