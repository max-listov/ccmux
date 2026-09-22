import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { routeStatePath } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';

/**
 * Which way each peer was last reached, so the log records a CHANGE rather than a level.
 *
 * "The remote route is down and this call went over ssh" is a condition, not an event: it does not
 * become truer the second time. Written once per call it produced twelve thousand identical lines
 * in a week on one machine — a fan-out poller multiplied by every peer — and a log that says the
 * same thing twelve thousand times has taught its reader that the message means nothing. The
 * standing state belongs where it is already published: `ccmux fleet` names the path each answer
 * took, `ccmux doctor` names the missing prerequisite, and every answer carries `fallback`.
 *
 * Shared by the daemon and by every short-lived CLI process, which is why it is a file rather than
 * a variable. It is advisory ONLY: a lost write or a race between two processes costs one repeated
 * warning or one missing one, never a routing decision. Nothing reads it to decide how to travel.
 */
const RouteStateSchema = z.record(z.string(), z.string());

function load(m: MachineConfig): Record<string, string> {
  const path = routeStatePath(m);
  if (!existsSync(path)) return {};
  try {
    return RouteStateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return {};
  }
}

async function remember(m: MachineConfig, machine: string, route: string): Promise<void> {
  try {
    await atomicWrite(routeStatePath(m), JSON.stringify({ ...load(m), [machine]: route }));
  } catch {
    // Advisory: failing to record costs a repeated warning, never a call.
  }
}

/** True when this peer was NOT already known to be falling back for this reason. */
export async function fallbackIsNew(
  m: MachineConfig,
  machine: string,
  reason: string,
): Promise<boolean> {
  const route = `ssh:${reason}`;
  const changed = load(m)[machine] !== route;
  if (changed) await remember(m, machine, route);
  return changed;
}

/** True when this peer was last seen on the fallback and has now come back to the remote route. */
export async function routeRecovered(m: MachineConfig, machine: string): Promise<boolean> {
  const previous = load(m)[machine];
  const recovered = previous?.startsWith('ssh:') === true;
  if (previous !== 'remote') await remember(m, machine, 'remote');
  return recovered;
}
