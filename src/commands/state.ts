import { forwardIfRemote } from '../fleet/forward.ts';
import { collectRows, toListItem } from '../inventory/rows.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { printLine } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';
import { parseFlags } from './flags.ts';
import { usageLine } from './help.ts';

/**
 * One session's state, asked by its ordinary address — for a job a session started.
 *
 * A long job (a render, a gate, an upload) runs in its own process and outlives nothing it was not
 * told about: when the session that led it dies, nothing reports that, and the job reads as running
 * for ever. Only the owner of session identity can answer, so the answer is here, by the address the
 * job already has — the one chat and the fleet list use — and not by a second identifier that would
 * drift from the first.
 *
 * `--since` is the time the job started. The answer then says whether the life that was running at
 * that moment still is: `same`, `restarted` (the address lives on in a new life — ownership reads
 * through the address, which a restart keeps), or `stopped`. A renew is visible as a changed
 * conversation id at the same address.
 *
 * Exit codes separate the three answers a caller must not confuse: 0 the session exists (in any
 * state), 3 no such session, 1 the question could not be asked (unknown or unreachable machine) —
 * "could not ask" is never reported as "does not exist".
 */
export const NOT_FOUND = 3;

export async function cmdState(args: string[]): Promise<number> {
  const flags = parseFlags('state', args, [0, 1]);
  const json = flags.bool('json');
  const sinceRaw = flags.str('since');
  const since = sinceRaw === undefined ? null : Date.parse(sinceRaw);
  if (since !== null && !Number.isFinite(since)) {
    console.error(`--since is not a time: ${sinceRaw}`);
    return 1;
  }
  const target = flags.positionals[0] ?? process.env.CCMUX_SESSION;
  if (target === undefined || target === '') {
    console.error(`${usageLine('state')}\nno address given and this is not a managed session`);
    return 1;
  }
  const forwarded = await forwardIfRemote(target, 'state', flags.flagArgs);
  if (forwarded.done) return forwarded.code;
  const { m, session: name } = forwarded;
  const address = `${m.rcPrefix}:${name}`;
  const session = findSession(loadSessions(m), name);
  if (session === undefined) {
    const reason = `no session named ${name} on ${m.rcPrefix}`;
    if (json) await printLine(JSON.stringify({ version: VERSION, address, exists: false, reason }));
    else console.error(reason);
    return NOT_FOUND;
  }
  const [row] = await collectRows(m, { only: session.name });
  if (row === undefined) {
    // Removed between the two reads: the registry answered first, and it is the authority.
    const reason = `no session named ${name} on ${m.rcPrefix}`;
    if (json) await printLine(JSON.stringify({ version: VERSION, address, exists: false, reason }));
    else console.error(reason);
    return NOT_FOUND;
  }
  const item = toListItem(m, row);
  const lifeStartedAt = item.createdAt;
  const life =
    since === null
      ? null
      : !item.running || lifeStartedAt === null
        ? 'stopped'
        : Date.parse(lifeStartedAt) > since
          ? 'restarted'
          : 'same';
  const answer = {
    version: VERSION,
    address,
    exists: true,
    running: item.running,
    archived: item.archived,
    state: item.state,
    lifeStartedAt,
    conversation: { agent: item.agent, id: item.uuid },
    since: sinceRaw ?? null,
    life,
    observedAt: new Date().toISOString(),
  };
  if (json) {
    await printLine(JSON.stringify(answer));
    return 0;
  }
  const started =
    lifeStartedAt === null ? 'not running' : `running since ${lifeStartedAt} (${item.uptime.text})`;
  await printLine(`${address}  ${item.state}${item.archived ? ' (archived)' : ''}  ${started}`);
  await printLine(`conversation ${item.agent} ${item.uuid}`);
  if (life !== null)
    await printLine(
      life === 'same'
        ? `since ${sinceRaw}: the same life is still running`
        : life === 'restarted'
          ? `since ${sinceRaw}: restarted — the address lives on in a new life`
          : `since ${sinceRaw}: stopped — the life that was running then has ended`,
    );
  return 0;
}
