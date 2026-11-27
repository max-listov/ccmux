import { readFileSync } from 'node:fs';
import { MachineConfigSchema } from '../../src/config/machineSchema.ts';
import { delegationStopped } from '../../src/delegation/cancel.ts';
import { registerRuntimeOwnership } from '../../src/runtime/ownership.ts';
import { SessionSchema } from '../../src/session/schema.ts';
import { ownerShouldSleep } from '../../src/session/sleep/store.ts';

const path = process.argv[2];
if (!path) throw Error('fixture input required');
const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
if (!raw || typeof raw !== 'object' || !('m' in raw) || !('s' in raw))
  throw Error('invalid fixture');
const m = MachineConfigSchema.parse(raw.m),
  s = SessionSchema.parse(raw.s);
const child = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
  detached: true,
});
// SIGUSR1 starts unrelated work under the owner — a build begun after a caller snapshotted the
// process table — and reports its pid on the next stdout line.
let work: ReturnType<typeof Bun.spawn> | null = null;
process.on('SIGUSR1', () => {
  work ??= Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  console.log(JSON.stringify({ workPid: work.pid }));
});
const end = () => {
  if (child.exitCode === null) child.kill('SIGTERM');
  if (work !== null && work.exitCode === null) work.kill('SIGTERM');
};
process.on('SIGTERM', () => {
  end();
  process.exit(0);
});
try {
  await registerRuntimeOwnership(m, s, child.pid);
  console.log(JSON.stringify({ pid: process.pid, providerPid: child.pid }));
  while (!ownerShouldSleep(m, s) && !delegationStopped(m, s)) await Bun.sleep(25);
} finally {
  end();
  await child.exited;
}
