import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { paneActivityPath } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';

/**
 * When each session's pane was last seen doing work — the machine's shared answer to "is this
 * session alive right now, or has it stopped".
 *
 * Everything that decides a turn is over decides it from SILENCE: the transcript has not moved for
 * long enough that a live turn would have written something. That test is exactly wrong for the
 * commonest kind of work: a session four minutes into a build writes nothing at all, and the only
 * thing still saying otherwise is its pane.
 *
 * A pane is not a fact a single process can check. Its mtime equivalent does not exist — the
 * spinner is instantaneous, so looking once tells you about this moment and nothing before it.
 * Sample it in the gap between a tool finishing and its result being written and there is no
 * spinner either, and on the transcript alone that is indistinguishable from a turn nobody is
 * coming back to.
 *
 * So the supervisor, which looks at every pane every couple of seconds anyway, writes down what it
 * saw. Two readers depend on it and neither could keep the memory itself:
 *
 *  - **`ccmux wait`** is a fresh process on every call, and its FIRST look is the dangerous one.
 *    It answers "is the peer done" for the whole fleet, and a false yes sends the caller to
 *    `transcript --last-message`, which hands back what was said BEFORE the tool calls that had not
 *    finished — a stale answer, reported as the result.
 *  - **deferred chat delivery** waits for a turn boundary; a false "between turns" spends that wait
 *    for nothing and lands the message inside the turn it was meant to follow.
 *
 * Staleness is safe in the direction that matters. If the supervisor stops, entries simply stop
 * advancing, and an old instant contributes nothing to "recently alive" — every reader degrades to
 * the transcript-only answer it used to give, never to a more confident one.
 */

const PaneActivitySchema = z.record(z.string(), z.number());

/** Best-effort: this is corroborating evidence, and a machine that cannot read it must still work —
 *  it simply falls back to judging by the transcript alone. */
export function readPaneActivity(m: MachineConfig): Record<string, number> {
  try {
    const path = paneActivityPath(m);
    if (!existsSync(path)) return {};
    return PaneActivitySchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).data ?? {};
  } catch {
    return {};
  }
}

/** When this one session's pane was last seen working, or null if nothing has recorded it. */
export function paneWorkingSince(m: MachineConfig, name: string): number | null {
  return readPaneActivity(m)[name] ?? null;
}

/** Rewrite the whole map. Written once per observation pass, so sessions that have gone are dropped
 *  rather than left behind as a growing record of machines that no longer exist. */
export async function writePaneActivity(
  m: MachineConfig,
  seen: Map<string, number>,
): Promise<void> {
  try {
    await atomicWrite(paneActivityPath(m), JSON.stringify(Object.fromEntries(seen)));
  } catch {
    // best-effort bookkeeping — never cost a pass its remaining sessions
  }
}
