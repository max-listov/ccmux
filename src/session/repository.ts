import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { rec, str } from '../agent/transcript/normalize.ts';
import { entryNames } from '../util/entryNames.ts';
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

/** The file a repository declares itself in, at the root of its checkout. */
const PASSPORT = '.passport.json';
/** A product key as the passport format defines it: no slash — `owner/name` is a repository. */
const PROJECT_MAX = 200;

/** What a file was when it was read; an answer is kept only while the file stays that. */
type Stamp = string | null;

function stampOf(path: string): Stamp {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** The directory itself, with links resolved — a checkout's neighbours are those of the place it
 *  really is; null when there is no such directory. */
function realDirectory(dir: string): string | null {
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The root of the checkout a directory is in: the nearest directory upwards that holds `.git`. */
function checkoutRoot(dir: string): string | null {
  let at = realDirectory(dir);
  if (at === null) return null;
  for (; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * Every answer below is remembered per file and dropped when the file changes — one rule for the
 * origin, a declaration and the list of neighbours. A follower asks again on every pass and has to
 * see a remote that was added, a declaration that was rewritten and a checkout that appeared,
 * without re-reading what did not move.
 */
function remembered<T>(kept: Map<string, { stamp: Stamp; value: T }>, read: (path: string) => T) {
  return (path: string): T => {
    const stamp = stampOf(path);
    const entry = kept.get(path);
    if (entry !== undefined && entry.stamp === stamp) return entry.value;
    const value = read(path);
    kept.set(path, { stamp, value });
    return value;
  };
}

/** What `git` said of a checkout's origin; `undefined` when it did not say — it timed out or could
 *  not be started — which is not "this checkout has none". */
async function readOrigin(root: string): Promise<string | null | undefined> {
  try {
    const result = await run(['git', '-C', root, 'config', '--get', 'remote.origin.url'], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.timedOut === true) return undefined;
    // Exit 1 is git's own "no such key": a checkout without an origin.
    return result.code === 0 ? repositoryKey(result.stdout) : result.code === 1 ? null : undefined;
  } catch {
    return undefined;
  }
}

const origins = new Map<string, { stamp: Stamp; value: Promise<string | null> }>();

/** Remembered while the checkout's git configuration stays as it was — and not at all when git
 *  gave no answer, so one slow moment does not become "no repository" for the life of a daemon. */
function originOf(root: string, config: string): Promise<string | null> {
  const stamp = stampOf(config);
  const kept = origins.get(root);
  if (kept !== undefined && kept.stamp === stamp) return kept.value;
  const value = readOrigin(root).then((origin) => {
    if (origin === undefined && origins.get(root)?.value === value) origins.delete(root);
    return origin ?? null;
  });
  origins.set(root, { stamp, value });
  return value;
}

/**
 * The file a checkout's remotes are written in. A worktree's `.git` is a file that names its own
 * directory inside the repository it belongs to, and the remotes are that repository's.
 */
function gitConfigOf(root: string): string {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'config');
    const own = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (own !== undefined) {
      const gitDir = resolve(root, own);
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      return join(resolve(gitDir, common), 'config');
    }
  } catch {
    // Read as far as it could be: the file itself is then what there is to watch.
  }
  return dotGit;
}

export function repositoryOf(dir: string | null): Promise<string | null> {
  const root = dir === null ? null : checkoutRoot(dir);
  if (root === null) return Promise.resolve(null);
  return originOf(root, gitConfigOf(root));
}

/** What a checkout's declaration says about whose it is. */
interface Declaration {
  /** The repository the declaration is of, when it names it. */
  repository: string | null;
  /** The product this repository says it belongs to. */
  project: string | null;
  /** The repository this one is the private working half of. */
  source: string | null;
  /** What the repository says it is to its product, when it says. */
  role: string | null;
}

function readDeclaration(path: string): Declaration | null {
  try {
    const passport = rec(JSON.parse(readFileSync(path, 'utf8')));
    const identity = rec(passport?.identity);
    const named = str(identity?.project) ?? '';
    return {
      repository: str(identity?.repositoryId) || null,
      // Exactly as written: the passport format does not trim, and a key is compared as a whole.
      project:
        named.trim() === '' || named.includes('/') || named.length > PROJECT_MAX ? null : named,
      source: str(rec(passport?.source)?.repositoryId) || null,
      role: str(identity?.role) || null,
    };
  } catch {
    return null;
  }
}

const declarationAt = remembered(
  new Map<string, { stamp: Stamp; value: Declaration | null }>(),
  readDeclaration,
);
const declarationOf = (root: string): Declaration | null => declarationAt(join(root, PASSPORT));

/** The names in a directory. Only names are kept: a declaration that appears inside one of them
 *  does not touch the directory, so each is asked for its declaration every time. */
const namesIn = remembered(new Map<string, { stamp: Stamp; value: string[] }>(), entryNames);

const sameRepository = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The project a directory's repository belongs to, as repositories themselves declare it.
 *
 * A repository's name says where work is kept, not whose it is: a product's public source, its
 * private working half and its companions are different repositories of one project, and only they
 * can say so. Two declarations count, both in the `.passport.json` at the root of a checkout:
 *
 * - the checkout's own `identity.project`;
 * - failing that, a checkout beside it — in the same parent directory — whose declaration names this
 *   repository as its `source.repositoryId` and carries an `identity.project`. A public or a
 *   client's source says nothing about its private half, so the half speaks for the pair.
 *
 * A directory that is not inside a checkout but holds checkouts — the folder a product's halves sit
 * in — belongs to the project every one of them resolves to, and to none when one of them resolves
 * to another project or to nothing.
 *
 * Null is a full answer: no declaration, a key the passport format refuses, or checkouts that name
 * different projects. It is never a guess from the name of a repository or of
 * a directory — a neighbour called `<name>-dev` that declares nothing is not a half of anything.
 */
export async function projectOf(dir: string | null): Promise<string | null> {
  const real = dir === null ? null : realDirectory(dir);
  if (real === null) return null;
  const root = checkoutRoot(real);
  return root === null ? projectOfFolder(real) : projectOfCheckout(root);
}

async function projectOfFolder(folder: string): Promise<string | null> {
  const checkouts = namesIn(folder)
    .map((name) => join(folder, name))
    .filter((path) => existsSync(join(path, '.git')));
  if (checkouts.length === 0) return null;
  // The checkouts of a folder are each other's neighbours: their declarations are read once for
  // all of them, and the first one that belongs elsewhere, or nowhere, settles the folder.
  const halves = halvesIn(folder);
  let project: string | null = null;
  for (const root of checkouts) {
    const named = await projectOfCheckout(root, halves);
    if (named === null || (project !== null && named !== project)) return null;
    project = named;
  }
  return project;
}

/** The declarations in a directory that speak for another repository: working halves. */
function halvesIn(parent: string): Declaration[] {
  return namesIn(parent)
    .map((name) => declarationOf(join(parent, name)))
    .filter((half): half is Declaration => half?.source != null && half.project !== null);
}

async function projectOfCheckout(
  root: string,
  halves: readonly Declaration[] = halvesIn(dirname(root)),
): Promise<string | null> {
  const own = declarationOf(root);
  if (own?.project != null) return own.project;
  // Asked only now: most checkouts have no such neighbour, and the origin costs a `git` process.
  if (halves.length === 0) return null;
  const repository = own?.repository ?? (await repositoryOf(root));
  if (repository === null) return null;
  const named = new Set(
    halves.flatMap((half) =>
      half.source !== null && sameRepository(half.source, repository) && half.project !== null
        ? [half.project]
        : [],
    ),
  );
  return named.size === 1 ? ([...named][0] as string) : null;
}

/** One checkout of a project on this machine. */
export interface ProjectCheckout {
  dir: string;
  repository: string | null;
  /** The role its declaration names; failing that, `private-workspace` for a checkout that names
   *  the source it is the working half of, and `source` for any other. */
  role: string;
  /** The directory asked about is in this checkout. */
  current: boolean;
}

/**
 * Where the rest of a directory's project is on this machine.
 *
 * A session sits in one checkout — usually the product's source — while the product's task queue and
 * its working rules live in the private half beside it. Which directory that is has no other record
 * the session can read: the same declarations that name the project name its checkouts. They are
 * the checkouts in one directory — beside the session's own, or inside a folder it was opened on —
 * that resolve to the same project.
 */
export async function projectCheckouts(
  dir: string | null,
): Promise<{ project: string; checkouts: ProjectCheckout[] } | null> {
  const real = dir === null ? null : realDirectory(dir);
  if (real === null) return null;
  const root = checkoutRoot(real);
  const folder = root === null ? real : dirname(root);
  const halves = halvesIn(folder);
  const project =
    root === null ? await projectOfFolder(real) : await projectOfCheckout(root, halves);
  if (project === null) return null;
  const checkouts: ProjectCheckout[] = [];
  for (const name of namesIn(folder).toSorted()) {
    const path = join(folder, name);
    if (!existsSync(join(path, '.git'))) continue;
    if ((await projectOfCheckout(path, halves)) !== project) continue;
    const declaration = declarationOf(path);
    checkouts.push({
      dir: path,
      repository: declaration?.repository ?? (await repositoryOf(path)),
      role: declaration?.role ?? (declaration?.source != null ? 'private-workspace' : 'source'),
      current: path === root,
    });
  }
  return { project, checkouts };
}

/** The fields as an answer carries them: present when a project is declared, absent otherwise. */
export async function declaredProject(
  dir: string | null,
): Promise<{ project?: string; checkouts?: ProjectCheckout[] }> {
  const found = await projectCheckouts(dir);
  return found === null ? {} : found;
}

/** Only the project: for an answer about a line, which names its own directory and no other. */
export async function declaredProjectOnly(dir: string | null): Promise<{ project?: string }> {
  const project = await projectOf(dir);
  return project === null ? {} : { project };
}
