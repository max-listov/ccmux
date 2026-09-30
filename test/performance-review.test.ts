import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlPublisher } from '../src/control/publisher.ts';
import { createControlClient } from '../src/control/transport/client.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { PeerRows } from '../src/inventory/peerRows.ts';
import { DaemonPerformance } from '../src/monitoring/performance.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { parsePaneInventory } from '../src/tmux/paneInventory.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('performance read cannot configure or reset collection; configuration is admitted and idempotent', async () => {
  const root = mkdtempSync('/tmp/ccmux-profile-read-');
  const m = makeMachine({ stateDir: root });
  const publisher = new ControlPublisher(m);
  const profile = new DaemonPerformance();
  const owned = createControlServer(m, publisher, undefined, () => m, undefined, {
    performance: profile,
  });
  const client = createControlClient({ socket: join(root, 'control', 'api.sock') });
  try {
    await client['daemon.performance.configure']({ enabled: true });
    profile.run('schedule/probe', () => {
      const until = performance.now() + 10;
      while (performance.now() < until) Math.sqrt(Math.random());
    });
    const first = await client['daemon.performance']({});
    expect(first.scopes.find((row) => row.name === 'schedule/probe')?.runs).toBe(1);
    const second = await client['daemon.performance']({});
    expect(second.since).toBe(first.since);
    expect(second.scopes.map((row) => ({ name: row.name, runs: row.runs }))).toEqual(
      first.scopes.map((row) => ({ name: row.name, runs: row.runs })),
    );
    expect(second.scopes.find((row) => row.name === 'schedule/probe')?.cpu).toEqual(
      first.scopes.find((row) => row.name === 'schedule/probe')?.cpu,
    );
    expect(second.producers).toEqual(first.producers);
    const same = await client['daemon.performance.configure']({ enabled: true });
    expect(same.since).toBe(first.since);
    expect(same.scopes).toEqual(second.scopes);
    const refused = await fetch('http://localhost/control/daemon/performance', {
      unix: join(root, 'control', 'api.sock'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    expect(refused.status).toBe(400);
    expect(profile.snapshot().scopes).toEqual(same.scopes);
    const lease = await owned.controls.mutations.acquire('daemon/performance');
    try {
      await expect(
        client['daemon.performance.configure']({ enabled: false }),
      ).rejects.toMatchObject({ code: 'BUSY', status: 429 });
      expect(profile.snapshot().enabled).toBe(true);
    } finally {
      if (lease.outcome === 'leased') lease.lease.release();
    }
    const reset = await client['daemon.performance.configure']({ enabled: true, reset: true });
    expect(reset.scopes).toEqual([]);
    const stopped = await client['daemon.performance.configure']({ enabled: false });
    expect(stopped.enabled).toBe(false);
  } finally {
    await client.close();
    publisher.close();
    owned.external.close();
    await owned.server.shutdown({ gracePeriodMs: 200 });
    await owned.observability.close();
    profile.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('peer CLI lists every registered row before observation and after its freshness deadline', async () => {
  const root = mkdtempSync('/tmp/ccmux-peer-gap-');
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    tmuxBin: Bun.which('tmux') ?? '/usr/bin/tmux',
    tmuxSocket: `ccmux-gap-${crypto.randomUUID()}`,
  });
  const config = join(root, 'machine.json');
  writeFileSync(config, JSON.stringify(m));
  await writeSessionsUnlocked(m, [
    makeSession({ name: 'agent-a', dir: root }),
    makeSession({ name: 'agent-b', dir: root, uuid: crypto.randomUUID(), archived: true }),
  ]);
  const rows = new PeerRows();
  const publisher = new ControlPublisher(m);
  const owned = createControlServer(m, publisher, undefined, () => m, undefined, {
    peerRows: () => rows.read(m),
  });
  const read = async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '../src/cli.ts'), '_peer-read', 'list'],
      { env: { ...process.env, CCMUX_CONFIG: config }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const answer = JSON.parse(out);
    expect(
      Object.values(answer.sessions.items)
        .map((row: unknown) => {
          if (typeof row !== 'object' || row === null || !('name' in row))
            throw new Error('missing name');
          return row.name;
        })
        .sort(),
    ).toEqual(['agent-a', 'agent-b']);
    return answer.sessions;
  };
  try {
    const cold = await read();
    rows.observe(
      m,
      {
        created: new Map([['agent-a', 100]]),
        agentPanes: new Map([['agent-a', '%10']]),
        panes: new Map([['agent-a', 'esc to interrupt']]),
      },
      Date.now() - 10_001,
    );
    expect(await read()).toEqual(cold);
  } finally {
    publisher.close();
    owned.external.close();
    await owned.server.shutdown({ gracePeriodMs: 200 });
    await owned.observability.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('inventory skips isolated invalid rows, retains agent death, and rejects an entirely invalid answer', () => {
  const text = 'broken\nagent-a|%1|%1|100\nforeign|broken||100\nagent-b|%3|%2|100';
  const rows = parsePaneInventory(text);
  expect([...rows.live]).toEqual(['agent-a']);
  expect([...rows.agentGone]).toEqual(['agent-b']);
  expect([...rows.startedAt]).toEqual([['agent-a', 100]]);
  expect(() => parsePaneInventory('broken\nforeign|broken||100')).toThrow('no valid rows');
  expect(parsePaneInventory('').live.size).toBe(0);
  const roots = parsePaneInventory(
    'broken\nagent-a|%1|%1|100|200|201|24\nagent-b|%2|%2|100|oops|201|24',
    true,
  );
  expect([...roots.roots]).toEqual([201, 200]);
  expect([...roots.peerLineLimits]).toEqual([['agent-a', 54]]);
});
