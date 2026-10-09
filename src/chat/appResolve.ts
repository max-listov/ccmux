import { redact, secretValuesFromEnv } from 'stitchkit/observability';
import { z } from 'zod';
import { CodexAppIdentityMismatch, connectCodexAppServer } from '../agent/codex/appServer.ts';
import { type CodexAppRpc, CodexAppRpcRefusal } from '../agent/codex/rpc.ts';
import { CodexAppUnavailable } from '../agent/codex/socket.ts';
import type { MachineConfig } from '../types.ts';
import { resolveCodexAppPeer } from './codexApp.ts';
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
  connect: (machine: MachineConfig) => Promise<CodexAppRpc> = connectCodexAppServer,
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
      const rpc = await connect(config);
      phase = 'thread/read';
      return rpc;
    });
    return { ok: true, peer };
  } catch (error) {
    const kind: AppResolveFailure['kind'] =
      error instanceof CodexAppUnavailable
        ? error.kind
        : error instanceof CodexAppRpcRefusal
          ? 'provider-refused'
          : error instanceof CodexAppIdentityMismatch
            ? 'identity-mismatch'
            : error instanceof z.ZodError
              ? 'invalid-provider-response'
              : 'unexpected-failure';
    return {
      ok: false,
      failure: {
        phase,
        kind,
        message: appResolveDiagnostic(
          error instanceof Error ? error.message || error.name : String(error),
        ),
        ...(error instanceof CodexAppRpcRefusal && error.code !== undefined
          ? { providerCode: error.code }
          : {}),
      },
    };
  }
}
