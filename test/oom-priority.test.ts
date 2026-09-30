import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyOomPriority,
  isRunner,
  type OomAccess,
  oomPlan,
  procOomAccess,
  readProcTable,
} from '../src/runtime/oomPriority.ts';
import { matchingProcessRoots } from '../src/util/procStat.ts';

// daemon 100 · tmux server 200 → pane `_run` 210 → agent 220 → build 230 → its worker 231;
// a browser 240 under the agent that raised itself; an unrelated process 300.
const table = {
  rows: [
    { pid: 100, parent: 1 },
    { pid: 101, parent: 100 },
    { pid: 200, parent: 1 },
    { pid: 210, parent: 200 },
    { pid: 220, parent: 210 },
    { pid: 230, parent: 220 },
    { pid: 231, parent: 230 },
    { pid: 240, parent: 220 },
    { pid: 300, parent: 1 },
  ],
  runners: [210],
};

test('cached tmux roots require the same birth time; missing and reused PIDs fail closed', () => {
  const roots = new Map([
    [100, 'first'],
    [200, 'second'],
    [300, 'gone'],
  ]);
  const actual = new Map([
    [100, 'reused'],
    [200, 'second'],
  ]);
  expect(matchingProcessRoots(roots, (pid) => actual.get(pid) ?? null)).toEqual([200]);
  expect(matchingProcessRoots(roots, (pid) => roots.get(pid) ?? null)).toEqual([100, 200, 300]);
});

function fakeAccess(
  values: Record<number, number>,
): OomAccess & { values: Record<number, number> } {
  return {
    values,
    read: (pid) => values[pid] ?? null,
    write: (pid, value) => {
      if (!(pid in values)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      values[pid] = value;
    },
  };
}

test('the spine is the daemon, the tmux server, the pane runner and its agent — nothing else', () => {
  const plan = oomPlan(table, 100);
  expect(plan.spine.sort()).toEqual([100, 200, 210, 220]);
  expect(plan.below.sort()).toEqual([101, 230, 231, 240]);
});

test('the spine is lowered and what merely inherited it goes back to 0', () => {
  const access = fakeAccess({
    100: 0,
    101: -300,
    200: 0,
    210: 0,
    220: -300,
    230: -300,
    231: -300,
    240: 300,
    300: 0,
  });
  expect(applyOomPriority(oomPlan(table, 100), -300, access)).toEqual({ lowered: 3, released: 3 });
  expect(access.values).toEqual({
    100: -300,
    101: 0,
    200: -300,
    210: -300,
    220: -300,
    230: 0,
    231: 0,
    240: 300,
    300: 0,
  });
  // A second pass changes nothing: the agent stays protected, its children stay releasable.
  expect(applyOomPriority(oomPlan(table, 100), -300, access)).toEqual({ lowered: 0, released: 0 });
});

test('a spine process protected further on purpose keeps its value; a lack of privilege stops the pass', () => {
  const access = fakeAccess({ 100: -900, 200: 0, 210: 0, 220: 0 });
  applyOomPriority(oomPlan(table, 100), -300, access);
  expect(access.values[100]).toBe(-900);
  const refused: OomAccess = {
    read: () => 0,
    write: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  expect(() => applyOomPriority(oomPlan(table, 100), -300, refused)).toThrow('denied');
});

const root = mkdtempSync(join(tmpdir(), 'ccmux-proc-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('the table is read from /proc: parent links, and the pane runners among interpreters', () => {
  const proc = (pid: number, comm: string, parent: number, argv: string[]) => {
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), 'stat'), `${pid} (${comm}) S ${parent} ${pid} ${pid} 0`);
    writeFileSync(join(root, String(pid), 'cmdline'), `${argv.join('\0')}\0`);
    mkdirSync(join(root, String(pid), 'task', String(pid)), { recursive: true });
    writeFileSync(
      join(root, String(pid), 'task', String(pid), 'children'),
      parent === 1 && pid === 200 ? '210' : pid === 210 ? '220' : '',
    );
  };
  proc(200, 'tmux: server', 1, ['tmux']);
  proc(210, 'bun', 200, [
    '/b/bun',
    '--no-env-file',
    '/h/.local/share/ccmux/app/ccmux.js',
    '_run',
    'agent-a',
  ]);
  proc(211, 'bun', 1, ['/b/bun', '/h/.local/share/ccmux/app/ccmux.js', 'daemon']);
  proc(220, 'claude', 210, ['claude', '--resume', 'x']);
  mkdirSync(join(root, 'self'));
  const read = readProcTable([200, 211], root);
  read.rows.sort((x, y) => x.pid - y.pid);
  expect(read).toEqual({
    rows: [
      { pid: 200, parent: 1 },
      { pid: 210, parent: 200 },
      { pid: 211, parent: 1 },
      { pid: 220, parent: 210 },
    ],
    runners: [210],
  });
  expect(isRunner(['bun', 'src/cli.ts', '_run', 'agent-a'])).toBe(true);
  expect(isRunner(['bun', 'other.js', '_run', 'agent-a'])).toBe(false);
});

test('task children include forks from worker threads; host entries outside roots are excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-scoped-proc-'));
  try {
    for (const [pid, parent] of [
      [100, 1],
      [101, 100],
      [102, 101],
      [103, 100],
      [999, 1],
    ]) {
      mkdirSync(join(dir, String(pid), 'task', String(pid)), { recursive: true });
      writeFileSync(
        join(dir, String(pid), 'stat'),
        `${pid} (worker) S ${parent} ${Array(17).fill('0').join(' ')} ${pid}`,
      );
      writeFileSync(join(dir, String(pid), 'task', String(pid), 'children'), '');
    }
    mkdirSync(join(dir, '100', 'task', '110'));
    writeFileSync(join(dir, '100', 'task', '110', 'children'), '101');
    mkdirSync(join(dir, '100', 'task', '120'));
    writeFileSync(join(dir, '100', 'task', '120', 'children'), '103');
    writeFileSync(join(dir, '101', 'task', '101', 'children'), '102');
    const table = readProcTable([100], dir);
    // The next complete pass switches to the PPID index when task fan-out costs more.
    expect(readProcTable([100], dir)).toEqual(table);
    expect(table.rows.map((r) => r.pid).sort()).toEqual([100, 101, 102, 103]);
    writeFileSync(join(dir, '101', 'oom_score_adj'), '-300');
    const access = procOomAccess(table.rows, dir);
    expect(access.read(101)).toBe(-300);
    writeFileSync(
      join(dir, '101', 'stat'),
      `101 (replacement) S 100 ${Array(17).fill('0').join(' ')} 9999`,
    );
    expect(access.read(101)).toBeNull();
    expect(() => access.write(101, 0)).toThrow('identity changed');
    expect(readFileSync(join(dir, '101', 'oom_score_adj'), 'utf8')).toBe('-300');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
