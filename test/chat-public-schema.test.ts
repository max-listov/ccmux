import { expect, test } from 'bun:test';
import { LogFrameSchema, LogPayloadSchema, LogRowSchema } from '../src/chat/feedSchema.ts';
import { LogRowSchema as runtimeRow } from '../src/chat/fleetLog.ts';
import { ChatPrincipalSchema, ChatTargetSchema } from '../src/chat/identitySchema.ts';
import { LogFrameSchema as runtimeFrame } from '../src/chat/logFeed.ts';
import {
  ChatPrincipalSchema as configPrincipal,
  ChatTargetSchema as configTarget,
} from '../src/config/schema.ts';
import * as client from '../src/control-service-client.ts';

test('runtime and public client share the same browser-safe feed and endpoint schemas', async () => {
  expect(configPrincipal).toBe(ChatPrincipalSchema);
  expect(configTarget).toBe(ChatTargetSchema);
  expect(runtimeRow).toBe(LogRowSchema);
  expect(runtimeFrame).toBe(LogFrameSchema);
  expect(client.LogRowSchema).toBe(LogRowSchema);
  expect(client.LogPayloadSchema).toBe(LogPayloadSchema);
  expect(client.LogFrameSchema).toBe(LogFrameSchema);
  expect(client.ChatPrincipalSchema).toBe(ChatPrincipalSchema);
  expect(client.ChatTargetSchema).toBe(ChatTargetSchema);
  const bundle = await Bun.build({
    entrypoints: ['./src/chat/feedSchema.ts'],
    target: 'browser',
    external: ['zod'],
  });
  expect(bundle.success).toBe(true);
  const source = await bundle.outputs[0]?.text();
  expect(source).toBeDefined();
  expect(source).not.toMatch(/node:|Bun\.|process\.|loadMachineConfig|fleetLog/);
});
