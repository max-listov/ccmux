/** The session option records the immutable agent pane id, independently of other windows. */
export const AGENT_PANE_OPTION = '@ccmux-agent-pane';
export const PANE_INVENTORY_FORMAT = `#{session_name}|#{pane_id}|#{${AGENT_PANE_OPTION}}|#{session_created}`;

/** Shared by healing and monitoring: a surviving auxiliary pane never proves agent liveness. */
export function parsePaneInventory(stdout: string) {
  const seen = new Map<string, Set<string>>();
  const agentPanes = new Map<string, string>();
  const startedAt = new Map<string, number>();
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const fields = line.split('|');
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
      epoch <= 0
    )
      throw new Error('invalid tmux observation');
    const panes = seen.get(name) ?? new Set<string>();
    panes.add(pane);
    seen.set(name, panes);
    if (agent) agentPanes.set(name, agent);
    startedAt.set(name, epoch);
  }
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
  return { live, agentGone, agentPanes, startedAt };
}
