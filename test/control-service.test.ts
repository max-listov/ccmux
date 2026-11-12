import { expect, test } from 'bun:test';
import { controlContract } from '../src/control/schema/contract.ts';
import { controlServiceEffects } from '../src/control/schema/service.ts';
import { ServiceEffectSchema } from '../src/control/schema/serviceEffect.ts';

const endpoints = Object.entries(controlContract.endpoints);

test('every control operation says whether it reads or writes', () => {
  // The compiler already refuses an operation without `meta.service`; this guards the value too,
  // because a cast or a spread contract can put a word there no transport classifies.
  const undeclared = endpoints
    .filter(([, endpoint]) => !ServiceEffectSchema.safeParse(endpoint.meta?.service).success)
    .map(([id]) => id);
  expect(undeclared).toEqual([]);
});

test('the effects a transport projects are the operations’ own, one per operation', () => {
  expect(Object.keys(controlServiceEffects).sort()).toEqual(endpoints.map(([id]) => id).sort());
  for (const [id, endpoint] of endpoints)
    expect([id, controlServiceEffects[id as keyof typeof controlServiceEffects]]).toEqual([
      id,
      endpoint.meta.service,
    ]);
});

test('every operation is a POST with a static JSON route and a unary JSON answer', () => {
  // What a service descriptor can carry. A route with parameters, a stream or a raw body would be
  // refused by the projection, and with it the whole service.
  const unfit = endpoints
    .filter(([, endpoint]) => {
      const shape = endpoint as Record<string, unknown>;
      return (
        endpoint.method !== 'POST' ||
        /[:*]/.test(endpoint.path) ||
        shape.params !== undefined ||
        shape.stream !== undefined ||
        shape.multipart !== undefined ||
        shape.rawBody === true ||
        shape.rawResponse === true ||
        shape.responseMeta !== undefined
      );
    })
    .map(([id]) => id);
  expect(unfit).toEqual([]);
});

test('reading is decided per operation, and idempotent is not read', () => {
  // The fleet reads and the per-session reads a remote caller is granted by reading the service.
  for (const id of [
    'fleet.list',
    'chat.log',
    'identity.whois',
    'identity.list',
    'message.read',
    'letter.list',
    'session.list',
    'session.wait',
    'daemon.performance',
  ] as const)
    expect([id, controlServiceEffects[id]]).toEqual([id, 'read']);
  // Each of these changes a session, the chat ledger or the daemon, idempotent or not.
  for (const id of [
    'letter.send',
    'message.send',
    'session.create',
    'session.archive',
    'session.start',
    'session.stop',
    'session.restart',
    'session.remove',
    'session.keys',
    'terminal.respond',
    'attachment.begin',
    'daemon.performance.configure',
  ] as const)
    expect([id, controlServiceEffects[id]]).toEqual([id, 'write']);
});
