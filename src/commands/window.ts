import { forwardIfRemote } from '../fleet/forward.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { listAgentLiveness, openAuxWindow } from '../tmux/agentPane.ts';
import { printLine } from '../util/stdout.ts';
import { VERSION } from '../util/version.ts';
import { parseFlags } from './flags.ts';
import { NOT_FOUND } from './state.ts';

/**
 * A window beside a session's agent, opened by the owner of the session's tmux tree.
 *
 * A consumer that wants a terminal next to an agent used to create it itself — guessing the tmux
 * server and session name, and writing into a tree ccmux owns without its knowledge. That window was
 * also what let a dead agent go unhealed: the session outlived its agent's pane, and the agent's index
 * address resolved to the consumer's pane. The window is now ccmux's to open, and its lifetime is
 * declared: it lives and dies with the session.
 */
export async function cmdWindow(args: string[]): Promise<number> {
  const flags = parseFlags('window', args, [1, 1]);
  const json = flags.bool('json');
  const target = flags.positionals[0] as string;
  const forwarded = await forwardIfRemote(target, 'window', flags.flagArgs);
  if (forwarded.done) return forwarded.code;
  const { m, session: name } = forwarded;
  const address = `${m.rcPrefix}:${name}`;
  const session = findSession(loadSessions(m), name);
  if (session === undefined) {
    console.error(`no session named ${name} on ${m.rcPrefix}`);
    return NOT_FOUND;
  }
  if (!(await listAgentLiveness(m)).live.has(session.name)) {
    console.error(`${address} is not running — a window lives inside a running session`);
    return 1;
  }
  const window = await openAuxWindow(m, session.name, session.dir);
  const tmux = { socket: m.tmuxSocket ?? null, session: session.name };
  if (json) {
    await printLine(
      JSON.stringify({ version: VERSION, address, tmux, window, lifetime: 'session' }),
    );
    return 0;
  }
  await printLine(
    `${address}  window ${window.windowId} (index ${window.windowIndex}), pane ${window.paneId}`,
  );
  await printLine(
    `tmux ${tmux.socket === null ? '' : `-L ${tmux.socket} `}attach -t '=${tmux.session}:' — it lives and dies with the session (stop, restart and heal take it down); ccmux never types into it`,
  );
  return 0;
}
