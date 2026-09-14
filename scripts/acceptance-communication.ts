import { resolve } from 'node:path';
import { readCommunicationAuthorization } from '../src/chat/communicationAuthorization.ts';

// Executable acceptance entrypoints call this before their runtime work. Importing a probe helper
// alone must not read caller files or demand authorization for work that has not been requested.
export function acceptanceAuthorizationPath() {
  const index = process.argv.indexOf('--communication-authorization');
  const path = index < 0 ? undefined : process.argv[index + 1];
  if (!path)
    throw new Error('Pass --communication-authorization <JSON file> with real user consent');
  return resolve(path);
}

export async function readAcceptanceCommunicationAuthorization() {
  return readCommunicationAuthorization(acceptanceAuthorizationPath());
}

/**
 * The script's own arguments, without the authorization flag and its value.
 *
 * A probe script that re-runs itself reads its first positional as the isolated root. Read from raw
 * `argv[2]`, the flag itself became that root — so the one invocation the requirement allows was
 * refused as "not an isolated probe directory", and the child never received the flag at all.
 */
export function acceptancePositionals(): string[] {
  const args = process.argv.slice(2);
  const index = args.indexOf('--communication-authorization');
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

/** What a re-run of this script must carry so the child can read the same authorization. */
export function acceptanceAuthorizationArgs(): string[] {
  return ['--communication-authorization', acceptanceAuthorizationPath()];
}
