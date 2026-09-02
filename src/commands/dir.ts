import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadMachineConfig } from '../config/machine.ts';
import { findSession, loadSessions, setSessionDir } from '../config/sessions.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { log } from '../util/log.ts';
import { printLine } from '../util/stdout.ts';

const USAGE =
  `usage: ccmux dir <name> <path>  ·  ccmux dir <name>  ·  ccmux dir (list)\n` +
  `       <machine>:<name> for another fleet machine`;

/**
 * `ccmux dir` — move a session's registered directory without losing its conversation.
 *
 * The directory was settable only at creation, so a checkout that moved left every session on it
 * registered against a path that is no longer the project — and the only way back was to recreate
 * the session, which throws the conversation away. That price is paid by whoever reorganises a
 * machine, which is why nobody does.
 *
 * The change applies to the NEXT start, because a running agent's working directory belongs to the
 * process, not to the registry: nothing here moves a live process, and pretending otherwise would be
 * worse than saying so. `list` marks the session `dir` until it is restarted.
 */
export async function cmdDir(args: string[]): Promise<number> {
  const target = args[0];
  if (target === undefined) return listDirs();
  if (target === '--help' || target === '-h') {
    await printLine(USAGE);
    return 0;
  }

  const forwarded = await forwardIfRemote(target, 'dir', args.slice(1));
  if (forwarded.done) return forwarded.code;
  const { m, session: name } = forwarded;

  const sessions = loadSessions(m);
  const session = findSession(sessions, name);
  if (!session) {
    console.error(`dir: no such session '${name}'`);
    return 1;
  }

  const path = args[1];
  if (path === undefined) {
    // Asking where a session is registered is a reading, not a malformed write.
    await printLine(`${name}: ${session.dir}`);
    return 0;
  }

  if (!isAbsolute(path)) {
    console.error(
      `dir: '${path}' is not an absolute path — a launch has no cwd to resolve it from`,
    );
    return 1;
  }
  // Existence is checked, and deliberately nothing else: what the directory MEANS — a checkout, a
  // project, a workspace — belongs to whoever keeps that catalogue, and ccmux only records what the
  // session declared. A path that exists but points one level up from the sources is a directory
  // this cannot tell from the right one; the operator can, which is why this reports rather than
  // guesses.
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(`dir: '${path}' is not a directory that exists here`);
    return 1;
  }
  if (path === session.dir) {
    await printLine(`${name}: already registered at ${path}`);
    return 0;
  }

  const previous = session.dir;
  if (!(await setSessionDir(m, name, path))) {
    console.error(`dir: no such session '${name}'`);
    return 1;
  }
  log.info({ msg: 'session directory declared', name });
  // Sessions sharing a directory are a normal arrangement — two agents on one checkout — and only
  // the named one moves. Saying which others stayed is cheaper than the operator discovering it.
  const sharing = sessions.filter((s) => s.name !== name && s.dir === previous).map((s) => s.name);
  await printLine(`${name}: ${previous} → ${path}`);
  await printLine(
    `  applies on the next start — a running agent's cwd belongs to its process: ccmux restart ${name}`,
  );
  if (sharing.length > 0)
    await printLine(`  still registered at ${previous}: ${sharing.join(', ')}`);
  return 0;
}

/** Where every session on this machine is registered, so a move can be planned against facts. */
async function listDirs(): Promise<number> {
  const m = loadMachineConfig();
  const sessions = loadSessions(m);
  if (sessions.length === 0) {
    await printLine('no sessions on this machine.');
    return 0;
  }
  const width = Math.max(...sessions.map((s) => s.name.length));
  for (const s of [...sessions].sort((a, b) => a.name.localeCompare(b.name))) {
    // A registered directory that no longer exists is the visible half of this problem; the invisible
    // half — a path that exists but is no longer the project — is why the marker says "gone" rather
    // than claiming the rest are right.
    const gone = existsSync(s.dir) ? '' : '   ← gone';
    await printLine(`${s.name.padEnd(width)}  ${s.dir}${gone}`);
  }
  return 0;
}
