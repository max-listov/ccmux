import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createApplication, type ManagedScheduleClock } from 'stitchkit/application';
import { encodeDir } from '../src/agent/claude/resume.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { ExternalStatusPublisher } from '../src/external/resident-publisher.ts';
import { readUsageFile } from '../src/usage/file.ts';
import { createUsageObservation } from '../src/usage/observation.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('daemon observation yields between sources and cancels its timer at lifecycle shutdown', async () => {
  const root = mkdtempSync('/tmp/ccmux-usage-observer-');
  const m = makeMachine({
    stateDir: root,
    projectsDir: join(root, 'projects'),
    rcPrefix: 'host-a',
  });
  const a = makeSession({ name: 'agent-a', dir: root }),
    b = makeSession({ name: 'agent-b', dir: root, uuid: crypto.randomUUID() });
  await writeSessionsUnlocked(m, [a, b]);
  const directory = join(m.projectsDir, encodeDir(root));
  mkdirSync(directory, { recursive: true });
  const paths = [a, b].map((s) => join(directory, `${s.uuid}.jsonl`));
  for (const path of paths)
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'one',
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(200000) }],
          usage: { input_tokens: 10 },
        },
      })}\n`,
    );
  let now = 0;
  const timers: { callback: () => void; at: number }[] = [];
  const clock: ManagedScheduleClock = {
    now: () => now,
    wallNow: () => new Date(now),
    schedule(callback, delay) {
      const timer = { callback, at: now + delay };
      timers.push(timer);
      return {
        cancel() {
          const i = timers.indexOf(timer);
          if (i >= 0) timers.splice(i, 1);
        },
      };
    },
  };
  const external = new ExternalStatusPublisher('host-a');
  const observer = createUsageObservation(() => m, external, clock);
  const app = createApplication({ id: 'usage-test', resources: [observer] });
  const tick = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error('No scheduled tick');
    now = timer.at;
    timer.callback();
    await setImmediate();
  };
  try {
    await app.start();
    await tick();
    await tick();
    for (const path of paths)
      expect(readUsageFile('agent', path, 'claude', UsageQuerySchema.parse({})).indexedBytes).toBe(
        65536,
      );
    expect(observer.status.active).toBe(0);
    expect(observer.status.runsCompleted).toBe(2);
    await app.shutdown();
    expect(timers).toHaveLength(0);
    expect(observer.status.accepting).toBe(false);
  } finally {
    await app.shutdown();
    external.close();
    rmSync(root, { recursive: true, force: true });
  }
});
