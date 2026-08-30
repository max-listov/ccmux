import { expect, test } from 'bun:test';
import {
  CCMUX_NATIVE_STREAM_PROFILE,
  encodeControlNativeStreamCursor,
  readControlNativeStreamCursor,
} from '../src/control/nativeStreamContract.ts';
import {
  CCMUX_CONTROL_SERVICE_INGRESS_PATH,
  CCMUX_CONTROL_SERVICE_PREFIX,
  CCMUX_CONTROL_SERVICE_REVISION,
  ControlServiceDescriptorSchema,
  ccmuxControlServiceDescriptor,
} from '../src/control/serviceDescriptor.ts';
import { makePeer } from './helpers.ts';

test('public control has one unversioned route family, descriptor and native profile', () => {
  expect(CCMUX_CONTROL_SERVICE_PREFIX).toBe('/ccmux/control');
  expect(CCMUX_CONTROL_SERVICE_INGRESS_PATH).toBe('/ccmux-control/invoke');
  expect(CCMUX_CONTROL_SERVICE_REVISION).toBe('current');
  expect(CCMUX_NATIVE_STREAM_PROFILE).toBe('ccmux-native');
  expect(ControlServiceDescriptorSchema.parse(ccmuxControlServiceDescriptor)).toEqual(
    ccmuxControlServiceDescriptor,
  );
  for (const revision of ['1', '2', '3']) {
    expect(
      ControlServiceDescriptorSchema.safeParse({ ...ccmuxControlServiceDescriptor, revision })
        .success,
    ).toBe(false);
  }
});

test('unversioned cursor preserves exact target and generation without accepting numbered aliases', () => {
  const target = makePeer({ agent: 'codex', session: 'agent-a' });
  const cursor = { generation: crypto.randomUUID(), sequence: 7 };
  const encoded = encodeControlNativeStreamCursor(target, cursor);
  expect(encoded).toStartWith('ccn_');
  expect(readControlNativeStreamCursor(encoded, target)).toEqual(cursor);
  expect(readControlNativeStreamCursor(null, target)).toBeNull();
  expect(() =>
    readControlNativeStreamCursor(encoded, { ...target, threadId: crypto.randomUUID() }),
  ).toThrow('another target');
  for (const prefix of ['ccn1_', 'ccn2_', 'ccn3_']) {
    expect(() => readControlNativeStreamCursor(encoded.replace(/^ccn_/, prefix), target)).toThrow();
  }
  expect(() => readControlNativeStreamCursor('ccn_invalid', target)).toThrow();
});
