import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { getProvider } from '../agent/index.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { findSession, loadSessions, setSessionDir } from '../session/registry.ts';
import { hasSession } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { log } from '../util/log.ts';
import { printLine } from '../util/stdout.ts';
import { alignedLines } from '../util/table.ts';
import { parseFlags } from './flags.ts';

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
  const [target, path] = parseFlags('dir', args, [0, 2]).positionals;
  if (target === undefined) return listDirs();

  const forwarded = await forwardIfRemote(target, 'dir', path === undefined ? [] : [path]);
  if (forwarded.done) return forwarded.code;
  const { m, session: name } = forwarded;

  const sessions = loadSessions(m);
  const session = findSession(sessions, name);
  if (!session) {
    console.error(`dir: no such session '${name}'`);
    return 1;
  }

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
  // The conversation moves with the session, because that is what the command promises.
  //
  // A provider that keeps history under a path DERIVED from the project directory — Claude does,
  // one file per conversation under an encoded copy of the cwd — leaves that file behind when the
  // directory changes. The session then refuses to start, correctly and loudly, and the operator is
  // told to move a file by hand: which makes "without losing its conversation" true only for
  // someone who reads the refusal and knows what to do with it.
  //
  // Nothing is guessed. The move happens only when the source exists and the destination does not;
  // anything else is left exactly as it is, and the refusal at start remains the honest fallback.
  const carried = conversationCarry(
    getProvider(session.agent),
    session,
    { ...session, dir: path },
    m,
  );
  if (carried?.blocked != null) {
    console.error(`dir: ${carried.blocked}`);
    return 1;
  }
  if (!(await setSessionDir(m, name, path))) {
    console.error(`dir: no such session '${name}'`);
    return 1;
  }
  if (carried?.moved) {
    mkdirSync(dirname(carried.to), { recursive: true });
    renameSync(carried.from, carried.to);
  }
  log.info({ msg: 'session directory declared', name });
  // Sessions sharing a directory are a normal arrangement — two agents on one checkout — and only
  // the named one moves. Saying which others stayed is cheaper than the operator discovering it.
  const sharing = sessions.filter((s) => s.name !== name && s.dir === previous).map((s) => s.name);
  await printLine(`${name}: ${previous} → ${path}`);
  if (carried?.moved) await printLine(`  conversation carried: ${carried.to}`);
  await printLine(
    `  applies on the next start — a running agent's cwd belongs to its process: ccmux restart ${name}`,
  );
  // Said only when there is something to keep writing. A live agent goes on appending at the OLD
  // location until it restarts, which quietly arms the next move: the file it writes there is
  // exactly what a move BACK would refuse to overwrite — a session blocked by its own leftovers,
  // with nothing in the message to explain it. Measured by the session that asked for this command.
  if (carried?.moved && (await hasSession(m, name)))
    await printLine(
      `  until that restart it keeps writing at ${carried.from} — move it back only after restarting, or that file will be in the way`,
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
  // A registered directory that no longer exists is the visible half of this problem; the invisible
  // half — a path that exists but is no longer the project — is why the marker says "gone" rather
  // than claiming the rest are right.
  const rows = [...sessions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => [s.name, `${s.dir}${existsSync(s.dir) ? '' : '   ← gone'}`]);
  for (const line of alignedLines(rows)) await printLine(line);
  return 0;
}

/**
 * Where this session's conversation would live before and after the move, when that is knowable.
 *
 * Null when the provider does not keep history at a directory-derived path — nothing to carry, and
 * inventing a move would be worse than leaving it. `blocked` is the one case that must not proceed
 * silently: a file already sitting at the destination is somebody else's conversation or an earlier
 * copy of this one, and choosing between them is not a decision a directory change gets to make.
 */
export function conversationCarry(
  provider: ReturnType<typeof getProvider>,
  before: Session,
  after: Session,
  m: MachineConfig,
): { from: string; to: string; moved: boolean; blocked: string | null } | null {
  const from = provider.historyFile(before, m);
  const to = provider.historyFile(after, m);
  if (from === null || to === null || from === to) return null;
  if (!existsSync(from)) return { from, to, moved: false, blocked: null };
  if (existsSync(to))
    return {
      from,
      to,
      moved: false,
      blocked: `a conversation already exists at ${to} — move or remove it first; nothing has changed`,
    };
  return { from, to, moved: true, blocked: null };
}
