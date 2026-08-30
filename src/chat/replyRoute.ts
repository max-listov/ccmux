import { existsSync } from 'node:fs';
import { routeFor } from '../fleet/address.ts';
import { isWirePeer, wireSocketPath } from '../fleet/wire.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { codexAppAddress } from './identity.ts';

/**
 * Whether a reply typed on THIS machine would actually reach the sender — and, when it would not,
 * the reason in the recipient's own words.
 *
 * Why a verdict and not a boolean: the tag this feeds is PRESCRIPTIVE (the prompt tells the agent to
 * use the pinned command verbatim), so a wrong verdict does not merely look untidy — it silently
 * sends the answer to the wrong place, with no error on either side. A bare "no route" is also the
 * one shape a reader cannot act on: it names no cause to check and no state to fix.
 */
export type ReplyRoute = { replyable: true } | { replyable: false; reason: string };

/**
 * The verdict is computed by the SAME resolver `msg` delivers with (`routeFor`), which is the whole
 * point of this module existing.
 *
 * The bug it closes: the reply hint used to consult `fleet` (the ssh map) directly and nothing else,
 * so every machine reached over the wire — the transport that exists precisely for peers ssh cannot
 * address — was declared unreachable while `ccmux msg <machine>:<session>` from that same box
 * delivered instantly. Asking the resolver means a direction that moves onto a new transport moves
 * the hint with it, and no second source of truth can drift from the first.
 *
 * The one thing checked beyond routing is the local end of the wire: `msg` resolves the exact remote
 * peer BEFORE queueing anything, so with no agent socket here the reply command would exit 1 rather
 * than queue for retry — and a command that errors is worse than none. Deliberately a file-existence
 * check, never a probe: this runs on the daemon's delivery cadence, and a timeout-shaped question
 * would answer "unreachable" for a healthy-but-busy agent — the same false negative in a new place.
 * Whether the far side is up is not asked and cannot be answered cheaply; the hop itself says so, and
 * says it honestly (queued, retried) when it fails.
 */
export function replyRouteFor(m: MachineConfig, machine: string, session: string): ReplyRoute {
  const route = routeFor(`${machine}:${session}`, m);
  if (route.kind === 'error') return { replyable: false, reason: route.message };
  if (route.kind === 'local') return { replyable: true };
  if (isWirePeer(m, route.machine)) {
    const socket = wireSocketPath(m);
    if (socket === null)
      return {
        replyable: false,
        reason: 'no stitchwire agent socket path is known here (HOME is unset)',
      };
    if (!existsSync(socket))
      return {
        replyable: false,
        reason: `the stitchwire agent is not running here — no socket at ${socket}`,
      };
  }
  return { replyable: true };
}

/** The verdict for a message's sender. `undefined` for a non-managed (`cli`) sender: there is no
 *  agent behind it to reply to, so the tag says nothing about routing rather than inventing a fact. */
export function replyRouteToSender(m: MachineConfig, from: ChatPrincipal): ReplyRoute | undefined {
  if (from.kind === 'managed') return replyRouteFor(m, from.machine, from.session);
  if (from.kind === 'codex-app')
    return replyRouteFor(m, from.machine, codexAppAddress(from.threadId));
  return undefined;
}
