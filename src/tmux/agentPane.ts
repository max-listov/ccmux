import type { MachineConfig } from '../types.ts';
import { run } from '../util/spawn.ts';
import { tmuxArgv } from './argv.ts';
import { exactTarget, paneTarget, sessionOptionTarget } from './target.ts';

/**
 * The session option naming the pane the agent runs in, by tmux's own immutable pane id.
 *
 * The agent pane used to be addressed as `=<name>:0.0`, which is an index, not an identity. Once a
 * session holds a second window and the agent's pane dies, tmux resolves that index to the second
 * window's pane — measured on a live server, with `base-index` 0 and with 1 — so a chat letter would
 * be typed into someone else's terminal, while `has-session` still said the session was alive and
 * nothing healed it. A pane id resolves to that pane or to nothing.
 */
export const AGENT_PANE_OPTION = '@ccmux-agent-pane';

/** Agent pane ids already resolved in this process, per tmux server and session name. A cached id
 *  goes stale when another process restarts the session; `onAgentPane` re-resolves on failure. */
const agentPanes = new Map<string, string>();

const paneKey = (m: MachineConfig, name: string): string => `${m.tmuxSocket ?? ''}\u0000${name}`;

/**
 * The target for this session's agent pane: its recorded pane id, or — for a session created before
 * the id was recorded — the index it was always addressed by. Such a session is given the id here
 * when it has a single pane, which is the only case where the index cannot be wrong.
 */
export async function agentPaneTarget(m: MachineConfig, name: string): Promise<string> {
  const key = paneKey(m, name);
  const cached = agentPanes.get(key);
  if (cached !== undefined) return cached;
  const { code, stdout } = await run(
    tmuxArgv(
      m,
      'list-panes',
      '-s',
      '-t',
      exactTarget(name),
      '-F',
      `#{pane_id} #{${AGENT_PANE_OPTION}}`,
    ),
  );
  if (code !== 0) return paneTarget(name);
  const panes = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter((parts) => parts[0]?.startsWith('%') === true);
  const recorded = panes[0]?.[1];
  if (recorded !== undefined && recorded !== '') {
    agentPanes.set(key, recorded);
    return recorded;
  }
  const only = panes.length === 1 ? panes[0]?.[0] : undefined;
  if (only === undefined) return paneTarget(name);
  await run(tmuxArgv(m, 'set-option', '-t', sessionOptionTarget(name), AGENT_PANE_OPTION, only));
  agentPanes.set(key, only);
  return only;
}

/** Record the agent pane this process just created, so the next call does not ask tmux again. */
export function rememberAgentPane(m: MachineConfig, name: string, pane: string): void {
  agentPanes.set(paneKey(m, name), pane);
}

/** Forget what this process knows about a session's agent pane (it is being replaced or removed). */
export function forgetAgentPane(m: MachineConfig, name: string): void {
  agentPanes.delete(paneKey(m, name));
}

/**
 * Run one tmux command against the agent pane. A failure on a cached id is retried once on a fresh
 * resolution: the cached pane may belong to a life of the session another process has since replaced.
 */
export async function onAgentPane(
  m: MachineConfig,
  name: string,
  argv: (target: string) => string[],
): Promise<Awaited<ReturnType<typeof run>>> {
  const wasCached = agentPanes.has(paneKey(m, name));
  const target = await agentPaneTarget(m, name);
  const first = await run(tmuxArgv(m, ...argv(target)));
  if (first.code === 0 || !wasCached) return first;
  forgetAgentPane(m, name);
  const fresh = await agentPaneTarget(m, name);
  return fresh === target ? first : run(tmuxArgv(m, ...argv(fresh)));
}

/**
 * The sessions whose agent is alive, and the ones whose agent pane is gone while the session is not.
 *
 * A session with another window outlives its agent's pane, so "the tmux session exists" stopped
 * meaning "the agent runs". One fork for the whole server: every pane with its session's recorded
 * agent pane. A session that recorded none (created before this) counts as alive while it exists.
 */
export async function listAgentLiveness(
  m: MachineConfig,
): Promise<{ live: Set<string>; agentGone: Set<string>; agentPanes: Map<string, string> }> {
  const { code, stdout } = await run(
    tmuxArgv(m, 'list-panes', '-a', '-F', `#{session_name}\t#{pane_id}\t#{${AGENT_PANE_OPTION}}`),
  );
  const live = new Set<string>();
  const recorded = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  if (code !== 0) return { live, agentGone: new Set(), agentPanes: recorded };
  for (const line of stdout.split('\n')) {
    const [session, pane, agent] = line.split('\t');
    if (!session || !pane) continue;
    if (!seen.has(session)) seen.set(session, new Set());
    seen.get(session)?.add(pane);
    if (agent) recorded.set(session, agent);
  }
  const agentGone = new Set<string>();
  for (const [session, panes] of seen) {
    const agent = recorded.get(session);
    if (agent === undefined || panes.has(agent)) live.add(session);
    else agentGone.add(session);
  }
  return { live, agentGone, agentPanes: recorded };
}

/**
 * Open a window beside the agent's, in the session's directory, and say where it is.
 *
 * The window is created detached, so the agent's window stays current and keeps its size, and ccmux
 * never types into it: every chat and key goes to the recorded agent pane. It lives and dies with the
 * session — `stop`, `restart`, and the heal of an agent whose pane died take the whole session down,
 * this window included. The session environment tmux hands every window carries only the instance
 * variables; an agent's chat credential is given to the agent process alone, so it is not here.
 */
export async function openAuxWindow(
  m: MachineConfig,
  name: string,
  dir: string,
): Promise<{ paneId: string; windowId: string; windowIndex: number }> {
  const { code, stdout, stderr } = await run(
    tmuxArgv(
      m,
      'new-window',
      '-d',
      '-t',
      sessionOptionTarget(name),
      '-c',
      dir,
      '-P',
      '-F',
      '#{pane_id} #{window_id} #{window_index}',
    ),
  );
  const [paneId, windowId, index] = stdout.trim().split(' ');
  if (code !== 0 || !paneId?.startsWith('%') || !windowId?.startsWith('@'))
    throw new Error(`tmux could not open a window in '${name}': ${stderr.trim() || stdout.trim()}`);
  return { paneId, windowId, windowIndex: Number.parseInt(index ?? '', 10) };
}
