import { AppError } from 'stitchkit';
import { type ApplicationAdmission, createBoundedAdmission } from 'stitchkit/application';
import type { z } from 'zod';
import type { ExternalStatusPublisher } from '../external/residentPublisher.ts';
import type { MachineConfig } from '../types.ts';
import { HostCatalogCache } from './modelCatalogCache.ts';
import { readControlModels } from './models.ts';
import { attachmentOperations } from './operations/attachment.ts';
import type { ControlOperationDependencies, OperationContext } from './operations/context.ts';
import { conversationOperations } from './operations/conversation.ts';
import { controlRefusal } from './operations/refusal.ts';
import { sessionOperations } from './operations/session.ts';
import { usageOperations } from './operations/usage.ts';
import type { ControlPublisher } from './publisher.ts';
import type { PerformanceConfigureSchema } from './schema/performance.ts';
import { TerminalPrompts } from './terminalPrompt.ts';

/**
 * One domain operation surface shared by local IPC and declared-service ingress.
 * Admission is created once here, so adding a transport cannot add capacity or a writer.
 */
export function createControlOperations(
  m: MachineConfig,
  publisher: ControlPublisher,
  external: ExternalStatusPublisher,
  upstream?: ApplicationAdmission,
  dependencies: ControlOperationDependencies = {},
) {
  const mutations = createBoundedAdmission({
    ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 8 }, perKey: { maxConcurrent: 1, maxKeys: 256 } },
  });
  const waits = createBoundedAdmission({
    ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 16 } },
  });
  const reads = createBoundedAdmission({
    ...(upstream ? { upstream } : {}),
    policy: { global: { maxConcurrent: 4 } },
  });
  // The host catalog outlives the call that asked for it; see `modelCatalogCache.ts`.
  const catalog = new HostCatalogCache((input, signal) => readControlModels(m, input, signal));
  const context: OperationContext = {
    m,
    publisher,
    external,
    mutations,
    waits,
    reads,
    catalog,
    dependencies,
  };
  const terminalPrompts = new TerminalPrompts(m);
  const operations = {
    performance: () => {
      const profile = dependencies.performance;
      if (!profile)
        throw new AppError('UNAVAILABLE', 'Daemon performance collection is unavailable', 503);
      return profile.snapshot();
    },
    performanceConfigure: (
      input: z.infer<typeof PerformanceConfigureSchema>,
      signal?: AbortSignal,
    ) =>
      mutations
        .run(
          'daemon/performance',
          () => {
            const profile = dependencies.performance;
            if (!profile)
              throw new AppError(
                'UNAVAILABLE',
                'Daemon performance collection is unavailable',
                503,
              );
            profile.start(input.enabled, input.reset);
            return profile.snapshot();
          },
          { ...(signal ? { signal } : {}), timeoutMs: 5_000 },
        )
        .catch(controlRefusal),
    terminalPrompt: (input: Parameters<TerminalPrompts['read']>[0]) => terminalPrompts.read(input),
    terminalRespond: (input: Parameters<TerminalPrompts['respond']>[0], signal?: AbortSignal) =>
      mutations.run(
        input.target.session,
        ({ signal: admitted }) => terminalPrompts.respond(input, admitted),
        { ...(signal ? { signal } : {}), timeoutMs: 5_000 },
      ),
    ...usageOperations(context),
    ...conversationOperations(context),
    ...attachmentOperations(context),
    ...sessionOperations(context),
  };
  const measure = dependencies.measure;
  const measured = measure
    ? new Proxy(operations, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (
            typeof value !== 'function' ||
            key === 'performance' ||
            key === 'performanceConfigure'
          )
            return value;
          return (...args: unknown[]) =>
            measure(`control/${String(key)}`, () => Reflect.apply(value, target, args));
        },
      })
    : operations;
  return { operations: measured, mutations, waits, reads, catalog };
}

export type ControlOperations = ReturnType<typeof createControlOperations>['operations'];
