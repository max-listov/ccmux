import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitOwnedCodexBoundary } from '../src/agent/codex/ownedEvents.ts';
import { OwnedCodexProjection } from '../src/agent/codex/ownedProjection.ts';
import type { OwnedCodexSnapshot } from '../src/agent/codex/ownedSchema.ts';
import { eventsPath } from '../src/config/paths.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * A boundary is announced once, and every boundary is announced.
 *
 * Reading only the ring's last entry did neither: a `turn-start` that stayed last was re-announced
 * on every publish, and a `turn-end` overtaken by the next event was never announced at all.
 * Measured on a live machine over a day — 2236 starts against 16 ends for native sessions, against
 * 193/193 for sessions whose boundaries come from turn hooks — which is a feed that looks healthy
 * and answers every question about turns wrongly.
 */
const feed = (m: ReturnType<typeof makeMachine>): { event: string }[] =>
  readFileSync(eventsPath(m), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { event: string });

test('native turn boundaries reach the feed exactly once each', () => {
  const m = makeMachine({ stateDir: mkdtempSync(join(tmpdir(), 'ccmux-boundary-')) });
  const s = makeSession({ agent: 'codex', runtime: 'app-server', eventsEnabled: true });
  const projection = new OwnedCodexProjection(m, s, process.pid);
  const snapshot = (kinds: OwnedCodexSnapshot['events'][number]['kind'][]): OwnedCodexSnapshot => ({
    ...projection.snapshot(),
    events: kinds.map((kind, index) => ({
      sequence: index + 1,
      at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      kind,
      state: kind === 'turn-start' ? ('working' as const) : ('idle' as const),
      turn: { id: `t${index}`, status: 'completed' as const, startedAt: null },
    })),
  });

  // One turn, then the same ring read again with nothing new: the publish that follows must be silent.
  let cursor = emitOwnedCodexBoundary(m, s, snapshot(['turn-start']), 0);
  cursor = emitOwnedCodexBoundary(m, s, snapshot(['turn-start']), cursor);
  cursor = emitOwnedCodexBoundary(m, s, snapshot(['turn-start']), cursor);
  expect(feed(m).map((row) => row.event)).toEqual(['turn-start']);

  // The end arrives behind a state change, so it is never the ring's last entry — and must still land.
  cursor = emitOwnedCodexBoundary(m, s, snapshot(['turn-start', 'turn-end', 'state']), cursor);
  expect(feed(m).map((row) => row.event)).toEqual(['turn-start', 'turn-end']);
  expect(cursor).toBe(3);
});
