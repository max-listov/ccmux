import { AppError } from 'stitchkit';
import type { ApplicationAdmission } from 'stitchkit/application';
import { createObservability } from 'stitchkit/observability';
import { createServer } from 'stitchkit/server';
import { ExternalStatusPublisher } from '../external/resident-publisher.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { controlAuth } from './auth.ts';
import type { ControlOperationDependencies } from './operations.ts';
import { controlSocket, prepareControlDirectory } from './path.ts';
import type { ControlPublisher } from './publisher.ts';
import { controlServices } from './service.ts';

/** Same-user IPC only. Provider credentials never cross this boundary. */
export function createControlServer(
  m: MachineConfig,
  publisher: ControlPublisher,
  upstream?: ApplicationAdmission,
  currentMachine: () => MachineConfig = () => m,
  external = new ExternalStatusPublisher(m.rcPrefix),
  dependencies: ControlOperationDependencies = {},
) {
  prepareControlDirectory(m);
  const controls = controlServices(m, publisher, external, upstream, {
    ...dependencies,
    assertExternalConfig() {
      const current = currentMachine();
      if (
        current.externalInventory !== m.externalInventory ||
        current.codexSessionsDir !== m.codexSessionsDir ||
        current.projectsDir !== m.projectsDir
      )
        throw new AppError('CONFIG_CHANGED', 'External content requires a restart', 503);
      dependencies.assertExternalConfig?.();
    },
  });
  const authorize = controlAuth(m);
  const observability = createObservability({
    request: {
      includePayload: false,
      maxPending: 64,
      write(event) {
        if (!event.ok || ['message', 'start', 'interrupt'].includes(event.action ?? ''))
          log.info({
            msg: 'control request',
            action: event.action,
            ok: event.ok,
            code: event.errorCode,
            durationMs: Math.round(event.durationMs),
          });
      },
      onSinkError(failure) {
        log.error({ msg: 'control audit failed', err: String(failure.error) });
      },
    },
  });
  const server = createServer({
    unix: { path: controlSocket(m), mode: 0o600 },
    services: controls.services,
    maxJsonBodyBytes: 64 * 1024,
    logging: false,
    ...(observability.request ? { observability: observability.request } : {}),
    hooks: {
      authorize: async (ctx, endpoint) => {
        const current = currentMachine();
        if (current.stateDir !== m.stateDir || current.rcPrefix !== m.rcPrefix) {
          throw new AppError('CONFIG_CHANGED', 'Control runtime requires a restart', 503);
        }
        if (ctx.req?.headers.has('origin'))
          throw new AppError('FORBIDDEN', 'Browser requests are not accepted on local IPC', 403);
        await authorize(ctx, endpoint);
      },
    },
  });
  return { server, controls, observability, external };
}
