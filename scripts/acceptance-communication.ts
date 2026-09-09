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
