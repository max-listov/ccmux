#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readOwnedCodexStatus } from '../src/agent/codex/ownedStatus.ts';
import { historyFile } from '../src/agent/codex/resume.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import { loadSessions } from '../src/config/sessions.ts';
import { createControlClient } from '../src/control/client.ts';
import { controlSocket } from '../src/control/path.ts';
import { hasSession } from '../src/tmux/tmux.ts';

const config = process.argv[2];
if (!config || !basename(dirname(config)).startsWith('ccmux-owned-probe-')) {
  throw new Error('Pass an isolated owned-runtime probe config');
}
const root = dirname(config);
const m = MachineConfigSchema.parse(JSON.parse(readFileSync(config, 'utf8')));
if (
  m.stateDir !== join(root, 'state') ||
  m.telegram ||
  Object.keys(m.fleet ?? {}).length ||
  !m.tmuxSocket?.startsWith('ccmux-owned-')
)
  throw new Error('Probe is not isolated');

const client = createControlClient({ socket: controlSocket(m) });
const requestId = crypto.randomUUID();
const name = `control-${requestId.slice(0, 8)}`;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(label: string, predicate: () => boolean | Promise<boolean>, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    check(Date.now() < deadline, `Timeout: ${label}`);
    await Bun.sleep(200);
  }
}

try {
  const first = await client['session.create']({
    requestId,
    name,
    workspace: root,
    flags: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--no-alt-screen'],
  });
  const retry = await client['session.create']({
    requestId,
    name,
    workspace: root,
    flags: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--no-alt-screen'],
  });
  check(
    !first.duplicate &&
      retry.duplicate &&
      JSON.stringify(first.target) === JSON.stringify(retry.target),
    'Duplicate create did not reconcile to one identity',
  );
  await until('new control session live', () => {
    const session = loadSessions(m).find((row) => row.name === name);
    return session !== undefined && readOwnedCodexStatus(m, session).status === 'live';
  });
  const rows = loadSessions(m).filter((row) => row.name === name);
  check(
    rows.length === 1 && rows[0]?.uuid === first.target.threadId,
    'Create published more than one registry identity',
  );
  const session = rows[0];
  check(session !== undefined, 'Created session is missing');
  const before = readOwnedCodexStatus(m, session).snapshot;
  const history = historyFile(session, m);
  check(
    before?.providerPid && history && existsSync(history),
    'Created identity has no live provider writer or history',
  );

  const archived = await client['session.archive']({ target: first.target });
  check(
    archived.archived && !archived.duplicate && archived.stopped,
    'First archive did not stop the owned runtime',
  );
  const archivedAgain = await client['session.archive']({ target: first.target });
  check(archivedAgain.duplicate, 'Archive retry was not idempotent');
  await until('archived tmux stopped', async () => !(await hasSession(m, name)), 10_000);
  const retained = loadSessions(m).find((row) => row.name === name);
  check(
    retained?.archived && retained.uuid === session.uuid,
    'Archive changed or removed the canonical identity',
  );
  check(existsSync(history), 'Archive deleted provider history');
  console.log(
    JSON.stringify({
      phase: 'control-lifecycle-complete',
      requestId,
      target: first.target,
      providerPid: before.providerPid,
      oneWriter: true,
      retryDuplicate: retry.duplicate,
      archiveDuplicate: archivedAgain.duplicate,
      historyRetained: true,
    }),
  );
} finally {
  await client.close();
}
