import { AppError } from 'stitchkit';
import type { ApplicationAdmission } from 'stitchkit/application';
import { createObservability } from 'stitchkit/observability';
import { createServer, withContractIdentity } from 'stitchkit/server';
import { ExternalStatusPublisher } from '../../external/residentPublisher.ts';
import type { MachineConfig } from '../../types.ts';
import { log } from '../../util/log.ts';
import type { ControlOperationDependencies } from '../operations/context.ts';
import type { ControlPublisher } from '../publisher.ts';
import { refusals } from '../schema/refusals.ts';
import { WireControlService } from '../wire/service.ts';
import { controlAuth, refuseOutsideService } from './auth.ts';
import { controlServices } from './service.ts';
import { controlSocket, prepareControlDirectory } from './socketPath.ts';

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
        throw refusals.errors.CONFIG_CHANGED({ message: 'External content requires a restart' });
      dependencies.assertExternalConfig?.();
    },
  });
  const authorize = controlAuth(m);
  const directory = m.remoteTransport?.serviceDirectory;
  const wire = directory ? new WireControlService(directory, controlSocket(m)) : undefined;
  const observability = createObservability({
    request: {
      includePayload: false,
      maxPending: 64,
      write(event) {
        if (!event.ok || ['message', 'start', 'interrupt'].includes(event.action ?? ''))
          log.info({
            msg: 'control request',
            action: event.action,
            caller: event.dimensions?.caller ?? null,
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
    ...(wire
      ? {
          wrapFetch: (dispatch) =>
            wire.wrap(
              dispatch,
              () => currentMachine().remoteTransport?.serviceDirectory === directory,
            ),
        }
      : {}),
    // Answered beside the operations themselves: a client reads which of them this daemon has and
    // whether their schemas are its own, before a call tells it by failing.
    services: withContractIdentity(controls.services),
    maxJsonBodyBytes: 64 * 1024,
    logging: false,
    ...(observability.request ? { observability: observability.request } : {}),
    hooks: {
      authorize: async (ctx, endpoint) => {
        const current = currentMachine();
        if (current.stateDir !== m.stateDir || current.rcPrefix !== m.rcPrefix) {
          throw refusals.errors.CONFIG_CHANGED({ message: 'Control runtime requires a restart' });
        }
        if (ctx.req?.headers.has('origin'))
          throw refusals.errors.FORBIDDEN({
            message: 'Browser requests are not accepted on local IPC',
          });
        await authorize(ctx, endpoint);
        refuseOutsideService(ctx.principal, endpoint.effect);
      },
      // An operation that declares its refusals answers an undeclared code as a bare 500; the
      // caller never learns which code it was, so the log has to (`SHARED_SESSION_REFUSALS`).
      onError: (_ctx, error, endpoint) => {
        if (
          error instanceof AppError &&
          error.code === 'INTERNAL_SERVER_ERROR' &&
          error.cause instanceof AppError
        )
          log.error({
            msg: 'control operation refused with a code it does not declare',
            action: endpoint?.key ?? null,
            code: error.cause.code,
            err: error.cause.message,
          });
        return undefined;
      },
    },
  });
  return { server, controls, observability, external, wire };
}
