import { JsonRpcError } from 'stitchkit/agent-executor';
import { CodexProtocolError } from 'stitchkit/agent-executor/codex';
import { redact, secretValuesFromEnv } from 'stitchkit/observability';
import { z } from 'zod';
import { CodexAppIdentityMismatch } from '../agent/codex/appServer.ts';
import { codexFailureKindOf, connectCodexAppServerControl } from '../agent/codex/owned/rpc.ts';
import type { MachineConfig } from '../types.ts';
import { type CodexAppResolveClient, resolveCodexAppPeer } from './codexApp.ts';
import { CodexAppPeerSchema } from './identitySchema.ts';

export const AppResolveFailureSchema = z.strictObject({
  phase: z.enum(['input', 'connect', 'thread/read']),
  kind: z.enum([
    'invalid-address',
    'configuration-unavailable',
    'endpoint-absent',
    'endpoint-not-listening',
    'upgrade-refused',
    'connection-lost',
    'provider-refused',
    'identity-mismatch',
    'invalid-provider-response',
    'unexpected-failure',
  ]),
  message: z.string().min(1),
  providerCode: z.number().optional(),
});
export type AppResolveFailure = z.infer<typeof AppResolveFailureSchema>;
export const AppResolveOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), peer: CodexAppPeerSchema }),
  z.strictObject({ ok: z.literal(false), failure: AppResolveFailureSchema }),
]);
export type AppResolveOutcome = z.infer<typeof AppResolveOutcomeSchema>;

/** Retain the diagnostic sentence; the family's sanitizer owns secret masking and bounds. */
export function appResolveDiagnostic(message: string): string {
  return z.string().parse(
    redact(message, {
      sensitiveValues: secretValuesFromEnv(process.env),
      maxStringLength: 16_384,
    }),
  );
}

export function appResolveFailureText(failure: AppResolveFailure): string {
  const code = failure.providerCode === undefined ? '' : `, RPC ${failure.providerCode}`;
  return `[${failure.kind}] at ${failure.phase}${code}: ${appResolveDiagnostic(failure.message)}`;
}

export async function resolveAppOutcome(
  machine: MachineConfig,
  threadId: string,
  connect: (
    machine: MachineConfig,
  ) => Promise<CodexAppResolveClient> = connectCodexAppServerControl,
): Promise<AppResolveOutcome> {
  if (!z.uuid().safeParse(threadId).success)
    return {
      ok: false,
      failure: { phase: 'input', kind: 'invalid-address', message: 'Thread UUID required' },
    };
  if (!machine.codexHome)
    return {
      ok: false,
      failure: {
        phase: 'connect',
        kind: 'configuration-unavailable',
        message: 'Codex home is not configured',
      },
    };
  let phase: AppResolveFailure['phase'] = 'connect';
  try {
    const peer = await resolveCodexAppPeer(machine, threadId, async (config) => {
      const controls = await connect(config);
      phase = 'thread/read';
      return controls;
    });
    return { ok: true, peer };
  } catch (error) {
    const socketKind = codexFailureKindOf(error);
    const kind: AppResolveFailure['kind'] =
      socketKind ??
      (error instanceof JsonRpcError
        ? 'provider-refused'
        : error instanceof CodexAppIdentityMismatch
          ? 'identity-mismatch'
          : error instanceof CodexProtocolError || error instanceof z.ZodError
            ? 'invalid-provider-response'
            : 'unexpected-failure');
    const rawMessage =
      error instanceof JsonRpcError
        ? `App Server RPC failed: ${error.message}`
        : error instanceof Error
          ? error.message || error.name
          : String(error);
    return {
      ok: false,
      failure: {
        phase,
        kind,
        message: appResolveDiagnostic(rawMessage),
        ...(error instanceof JsonRpcError ? { providerCode: error.code } : {}),
      },
    };
  }
}
