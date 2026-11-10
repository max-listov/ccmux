import { run } from '../util/spawn.ts';

/**
 * The repository a directory is a checkout of, as `owner/name` — read from the address of its
 * `origin`, which is the one name of a checkout that does not depend on where it sits on a disk.
 *
 * A consumer that files work by project has only a session's directory to go on, and a directory is
 * a fact about one machine: the same repository is checked out under different paths on each. Null
 * is a full answer here — no directory, not a checkout, no `origin`, or an address with no owner in
 * it — and is never a guess from the directory's own name.
 */
export function repositoryKey(origin: string): string | null {
  const address = origin.trim().replace(/\/+$/, '');
  if (address === '') return null;
  // `host:owner/name` (scp form) or a URL: either way the last two segments of the path.
  const path = /^[\w.+-]+:\/\//.test(address)
    ? address.replace(/^[\w.+-]+:\/\/[^/]*\//, '')
    : address.includes(':')
      ? address.slice(address.indexOf(':') + 1)
      : address;
  const [name, owner] = path
    .replace(/\.git$/, '')
    .split('/')
    .filter((part) => part !== '')
    .reverse();
  return owner === undefined || name === undefined ? null : `${owner}/${name}`;
}

const GIT_TIMEOUT_MS = 5_000;

/** One answer per directory per process: a search names the same few directories in every line. */
const known = new Map<string, Promise<string | null>>();

async function readOrigin(dir: string): Promise<string | null> {
  try {
    const result = await run(['git', '-C', dir, 'config', '--get', 'remote.origin.url'], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return result.code === 0 ? repositoryKey(result.stdout) : null;
  } catch {
    return null;
  }
}

export function repositoryOf(dir: string | null): Promise<string | null> {
  if (dir === null) return Promise.resolve(null);
  const cached = known.get(dir);
  if (cached !== undefined) return cached;
  const answer = readOrigin(dir);
  known.set(dir, answer);
  return answer;
}
