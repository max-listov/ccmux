import { measureCpu } from '../util/cpuScope.ts';
import { log } from '../util/log.ts';
/** The session option records the immutable agent pane id, independently of other windows. */
export const AGENT_PANE_OPTION = '@ccmux-agent-pane';
export const PANE_INVENTORY_FORMAT = `#{session_name}|#{pane_id}|#{${AGENT_PANE_OPTION}}|#{session_created}`;

/** Shared by healing and monitoring: a surviving auxiliary pane never proves agent liveness. */
function parsePaneInventoryImpl(stdout: string, withProcessRoots = false) {
  const seen = new Map<string, Set<string>>();
  const agentPanes = new Map<string, string>();
  const startedAt = new Map<string, number>();
  const roots = new Set<number>();
  const peerLineLimits = new Map<string, number>();
  let rejected = 0;
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const fields = line.split('|');
    const height = withProcessRoots ? Number(fields.pop()) : 0;
    const serverPid = withProcessRoots ? Number(fields.pop()) : 0;
    const panePid = withProcessRoots ? Number(fields.pop()) : 0;
    const created = fields.pop();
    const agent = fields.pop();
    const pane = fields.pop();
    const name = fields.join('|');
    const epoch = Number(created);
    if (
      !name ||
      !pane?.match(/^%\d+$/) ||
      (agent && !agent.match(/^%\d+$/)) ||
      !Number.isSafeInteger(epoch) ||
      epoch <= 0 ||
      (withProcessRoots &&
        (!Number.isSafeInteger(height) ||
          height <= 0 ||
          !Number.isSafeInteger(serverPid) ||
          serverPid <= 1 ||
          !Number.isSafeInteger(panePid) ||
          panePid <= 1))
    ) {
      rejected++;
      continue;
    }
    const panes = seen.get(name) ?? new Set<string>();
    panes.add(pane);
    seen.set(name, panes);
    if (agent) agentPanes.set(name, agent);
    startedAt.set(name, epoch);
    if (withProcessRoots) {
      roots.add(serverPid);
      roots.add(panePid);
      if (!agent || pane === agent) peerLineLimits.set(name, height + 30);
    }
  }
  if (rejected > 0 && !invalidReported) {
    invalidReported = true;
    log.warn({ msg: 'invalid tmux inventory rows skipped', reason: 'invalid-fields', rejected });
  } else if (rejected === 0) invalidReported = false;
  if (rejected > 0 && seen.size === 0) throw new Error('invalid tmux observation: no valid rows');
  const live = new Set<string>(),
    agentGone = new Set<string>();
  for (const [name, panes] of seen) {
    const agent = agentPanes.get(name);
    if (agent === undefined || panes.has(agent)) live.add(name);
    else {
      agentGone.add(name);
      startedAt.delete(name);
    }
  }
  return { live, agentGone, agentPanes, startedAt, roots, peerLineLimits };
}

// One warning per continuous invalid episode, without publishing raw pane/session data.
let invalidReported = false;

export function parsePaneInventory(
  ...args: Parameters<typeof parsePaneInventoryImpl>
): ReturnType<typeof parsePaneInventoryImpl> {
  return measureCpu(() => parsePaneInventoryImpl(...args));
}
