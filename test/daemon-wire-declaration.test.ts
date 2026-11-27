import { afterEach, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonApplication } from '../src/daemon/application.ts';
import { declaredServiceConfig, grantCallers } from './declared-service.ts';
import { makeMachine, shortTempDir } from './helpers.ts';

const roots: string[] = [];
const previous = process.env.STITCHMUX_CONFIG;
afterEach(() => {
  if (previous === undefined) delete process.env.STITCHMUX_CONFIG;
  else process.env.STITCHMUX_CONFIG = previous;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Every schedule gets a clock that never fires, so the application starts and stops only its
// resources — the control socket and the service declaration among them.
const still = () => ({
  now: () => performance.now(),
  wallNow: () => new Date(),
  schedule: () => ({ cancel: () => {} }),
});

test('the daemon publishes the control service declaration once it serves, and withdraws it when it stops', async () => {
  const root = shortTempDir('wire-decl-');
  roots.push(root);
  const services = join(root, 'services');
  grantCallers(services, [{ caller: 'host-b', scope: { kind: 'service-read' } }]);
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a', ...declaredServiceConfig(services) });
  const config = join(root, 'machine.json');
  writeFileSync(config, `${JSON.stringify(m)}\n`);
  process.env.STITCHMUX_CONFIG = config;
  const declaration = join(services, 'stitchmux.control.declaration.json');

  const { application } = createDaemonApplication(m, still);
  expect(existsSync(declaration)).toBe(false);
  await application.start();
  try {
    expect(existsSync(declaration)).toBe(true);
    expect(existsSync(join(services, 'stitchmux.control.json'))).toBe(true);
  } finally {
    await application.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
  }
  expect(existsSync(declaration)).toBe(false);
});

test('a daemon without a service directory declares nothing', async () => {
  const root = shortTempDir('wire-none-');
  roots.push(root);
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
  const config = join(root, 'machine.json');
  writeFileSync(config, `${JSON.stringify(m)}\n`);
  process.env.STITCHMUX_CONFIG = config;
  const { application } = createDaemonApplication(m, still);
  const started = await application.start();
  try {
    expect(started.resources.some((resource) => resource.id === 'wire-declaration')).toBe(false);
  } finally {
    await application.shutdown({ gracePeriodMs: 1_000, forceTimeoutMs: 1_000 });
  }
});
