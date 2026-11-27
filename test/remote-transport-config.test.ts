import { expect, test } from 'bun:test';
import { RemoteTransportSchema } from '../src/config/remoteTransport.ts';

test('the remote transport is the Stitchwire agent, and a route without its kind is refused by name', () => {
  expect(RemoteTransportSchema.parse({ kind: 'stitchwire', peers: ['host-b'] })).toMatchObject({
    kind: 'stitchwire',
    peers: ['host-b'],
  });
  // The separately supplied adapter this replaced took `{ socket, peers }` with no kind.
  const legacy = RemoteTransportSchema.safeParse({
    socket: '/tmp/adapter.sock',
    peers: ['host-b'],
  });
  expect(legacy.success).toBe(false);
  const paths = legacy.error?.issues.map((issue) => issue.path.join('.')) ?? [];
  expect(paths).toContain('kind');
});
