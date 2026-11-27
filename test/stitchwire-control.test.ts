import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceCaller } from '@stitchwire/client';
import { type ServiceDeclaration, ServiceDeclarationSchema } from '@stitchwire/client/contracts';
import { createUnixClientTransport } from 'stitchkit/server';
import { ControlPublisher } from '../src/control/publisher.ts';
import { controlContract } from '../src/control/schema/contract.ts';
import { createControlServer } from '../src/control/transport/server.ts';
import { controlSocket } from '../src/control/transport/socketPath.ts';
import { wireControlDescriptor as descriptor } from '../src/control/wire/descriptor.ts';
import { VERSION } from '../src/util/version.ts';
import { makeMachine, shortTempDir } from './helpers.ts';

test('the configured daemon serves its own control contract and revokes invalid or removed caller grants', async () => {
  const root = shortTempDir('wire-');
  const directory = join(root, 'services');
  await mkdir(directory, { mode: 0o700 });
  const callersPath = join(directory, 'ccmux.control.callers.json');
  const declarationPath = join(directory, 'ccmux.control.declaration.json');
  const policy: ServiceDeclaration['callers'] = [
    { caller: 'reader', scope: { kind: 'service-read' } },
  ];
  await writeFile(callersPath, JSON.stringify(policy));
  const m = makeMachine({
    stateDir: root,
    rcPrefix: 'host-a',
    remoteTransport: { kind: 'stitchwire', serviceDirectory: directory },
  });
  const publisher = new ControlPublisher(m);
  const owned = createControlServer(m, publisher);
  const wire = owned.wire;
  if (!wire) throw new Error('Missing configured Wire service');
  const http = createUnixClientTransport({ socketPath: controlSocket(m) });
  const envelope = (operation: string, caller = 'reader', revision = VERSION) => ({
    v: 1,
    id: crypto.randomUUID(),
    service: 'ccmux.control',
    revision,
    operation,
    caller,
    payload: '{}',
  });
  const invoke = (operation: string, caller?: string, revision?: string) =>
    http.fetch('http://ccmux.local/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope(operation, caller, revision)),
    });
  try {
    await wire.start();
    const declared = ServiceDeclarationSchema.parse(
      JSON.parse(await readFile(declarationPath, 'utf8')),
    );
    expect(declared.callers).toEqual(policy);
    expect(declared.binding).toMatchObject({
      service: 'ccmux.control',
      socketPath: controlSocket(m),
      endpointPath: '/invoke',
    });
    const artifact = JSON.parse(await readFile(declared.binding.descriptorPath, 'utf8'));
    expect(artifact).toEqual(descriptor);
    expect(artifact.revision).toBe(VERSION);
    expect(Object.fromEntries(descriptor.operations.map((op) => [op.id, op.effect]))).toEqual(
      Object.fromEntries(
        Object.entries(controlContract.endpoints).map(([id, op]) => [id, op.effect]),
      ),
    );
    const ok = await invoke('external.list');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ machine: 'host-a', source: 'codex-app-server' });
    const denied = await invoke('session.wake');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden' });
    expect((await invoke('external.list', 'other')).status).toBe(403);
    expect((await invoke('external.list', 'reader', '0.0.1')).status).toBe(400);
    expect((await invoke('unknown.operation')).status).toBe(400);
    // The SDK carries the authenticated identity to dispatch as request context.
    const auth = wire.wrap(
      async (req) => Response.json(serviceCaller({ req })),
      () => true,
    );
    const request = new Request('http://ccmux.local/invoke', {
      method: 'POST',
      headers: { 'x-ccmux-caller': 'other' },
      body: JSON.stringify(envelope('external.list')),
    });
    expect(await (await auth(request)).json()).toMatchObject({
      caller: 'reader',
      operation: 'external.list',
    });
    for (const invalid of [
      '{',
      JSON.stringify([...policy, ...policy]),
      JSON.stringify([{ caller: 'reader', scope: { kind: 'operation', operation: 'gone' } }]),
    ]) {
      await writeFile(callersPath, invalid);
      await wire.refresh();
      expect(JSON.parse(await readFile(declarationPath, 'utf8')).callers).toEqual([]);
      expect((await invoke('external.list')).status).toBe(403);
    }
    await writeFile(
      callersPath,
      JSON.stringify([
        { caller: 'other', scope: { kind: 'operation', operation: 'external.list' } },
      ]),
    );
    await wire.refresh();
    expect((await invoke('external.list', 'other')).status).toBe(200);
    expect((await invoke('external.list', 'reader')).status).toBe(403);
  } finally {
    await wire.close();
    await http.close();
    await owned.server.shutdown();
    publisher.close();
    await owned.observability.close();
  }
  expect(await Bun.file(declarationPath).exists()).toBe(false);
});

test('a machine configured for SSH alone exposes its local control API and no Wire ingress', async () => {
  const m = makeMachine({ stateDir: shortTempDir('ssh-'), fleet: { 'host-b': 'example.invalid' } });
  const publisher = new ControlPublisher(m);
  const owned = createControlServer(m, publisher);
  const http = createUnixClientTransport({ socketPath: controlSocket(m) });
  try {
    expect(owned.wire).toBeUndefined();
    expect(
      (await http.fetch('http://ccmux.local/invoke', { method: 'POST', body: '{}' })).status,
    ).toBe(404);
    expect(
      (
        await http.fetch('http://ccmux.local/control/external', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(200);
  } finally {
    await http.close();
    await owned.server.shutdown();
    publisher.close();
    await owned.observability.close();
  }
});
