import { describe, expect, test } from 'bun:test';
import {
  RemoteTransportRequestSchema,
  RemoteTransportResultSchema,
  remoteTransportContract,
} from '../src/fleet/remoteTransportContract.ts';

describe('generic remote transport contract', () => {
  test('carries commands without naming a provider protocol', () => {
    expect(remoteTransportContract.endpoints.call.path).toBe('/call');
    expect(
      RemoteTransportRequestSchema.parse({
        to: 'dev',
        argv: ['ccmux', 'list', '--json'],
        stdin: null,
        timeoutMs: 30_000,
      }),
    ).toEqual({
      to: 'dev',
      argv: ['ccmux', 'list', '--json'],
      stdin: null,
      timeoutMs: 30_000,
    });
  });

  test('requires explicit delivery certainty on transport failure', () => {
    expect(
      RemoteTransportResultSchema.safeParse({
        code: 1,
        stdout: '',
        stderr: '',
        transportFailed: true,
        delivery: 'not-sent',
        failureDetail: 'remote transport unavailable',
      }).success,
    ).toBe(true);
    expect(
      RemoteTransportResultSchema.safeParse({
        code: 1,
        stdout: '',
        stderr: '',
        transportFailed: true,
      }).success,
    ).toBe(false);
  });
});
