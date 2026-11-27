import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createServiceIngress,
  removeServiceDeclarationFile,
  serviceCaller,
  writeServiceDeclarationFile,
} from '@stitchwire/client';
import {
  SERVICE_MAX_DECLARATION_BYTES,
  type ServiceDeclaration,
  ServiceDeclarationSchema,
} from '@stitchwire/client/contracts';
import { readJsonOnce } from 'stitchkit/files';
import type { FetchHandler } from 'stitchkit/server';
import { atomicWrite } from '../../util/atomic.ts';
import { log } from '../../util/log.ts';
import { ControlTransportCallerSchema } from '../transport/boundary.ts';
import { wireControlDescriptor as descriptor } from './descriptor.ts';

const declarationFile = 'stitchmux.control.declaration.json';
const endpointPath = '/invoke';
const effects = new Map(descriptor.operations.map((operation) => [operation.id, operation.effect]));
const limits = {
  requestBytes: Math.max(...descriptor.operations.map((op) => op.limits.requestBytes)),
  responseBytes: Math.max(...descriptor.operations.map((op) => op.limits.responseBytes)),
  timeoutMs: Math.max(...descriptor.operations.map((op) => op.limits.timeoutMs)),
};
type Callers = ServiceDeclaration['callers'];

/** The operator's grants, or an error saying why there are none: missing, unreadable or invalid. */
function readCallers(path: string): Callers {
  const reading = readJsonOnce(path, ServiceDeclarationSchema.shape.callers, {
    limit: SERVICE_MAX_DECLARATION_BYTES,
  });
  if (reading.state === 'missing') throw new Error(`No callers file at ${path}`);
  if (reading.state !== 'read')
    throw new Error(`Callers file is ${reading.state}: ${reading.detail}`);
  const callers = reading.value;
  const seen = new Set<string>();
  for (const { caller, scope } of callers) {
    ControlTransportCallerSchema.parse(caller);
    if (scope.kind === 'operation' && !effects.has(scope.operation))
      throw new Error(`Unknown stitchmux.control operation: ${scope.operation}`);
    const key = JSON.stringify([caller, scope]);
    if (seen.has(key)) throw new Error('Duplicate caller scope');
    seen.add(key);
  }
  return callers;
}

/** One daemon owns the service declaration, caller grants and in-process ingress. */
export class WireControlService {
  private callers: Callers = [];
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | undefined;
  private published = false;
  private stopped = false;
  private problem: string | null = null;

  constructor(
    readonly directory: string,
    private readonly socketPath: string,
  ) {}

  wrap(dispatch: FetchHandler, isCurrent: () => boolean): FetchHandler {
    const invoke = createServiceIngress({
      descriptor,
      handler: (request) => {
        const identity = serviceCaller({ req: request });
        if (
          !identity ||
          !isCurrent() ||
          !this.callers.some(
            ({ caller, scope }) =>
              caller === identity.caller &&
              (scope.kind === 'operation'
                ? scope.operation === identity.operation
                : effects.get(identity.operation) === 'read'),
          )
        ) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        return dispatch(request);
      },
    });
    return (request, server) => {
      if (new URL(request.url).pathname !== endpointPath || request.method !== 'POST')
        return dispatch(request, server);
      if (request.headers.has('origin'))
        return Promise.resolve(Response.json({ error: 'forbidden' }, { status: 403 }));
      return invoke(request);
    };
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(
      join(this.directory, 'stitchmux.control.json'),
      `${JSON.stringify(descriptor, null, 2)}\n`,
      0o600,
    );
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => this.report(String(error)));
    }, 5_000);
    this.timer.unref();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending ??= this.publish().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async publish(): Promise<void> {
    let callers: Callers = [];
    let problem: string | null = null;
    try {
      callers = readCallers(join(this.directory, 'stitchmux.control.callers.json'));
    } catch (error) {
      problem = String(error);
    }
    const binding = {
      service: descriptor.service,
      descriptorPath: join(this.directory, 'stitchmux.control.json'),
      socketPath: this.socketPath,
      endpointPath,
      maxInflight: descriptor.maxInflight,
      limits,
    };
    try {
      await writeServiceDeclarationFile(
        declarationFile,
        { binding, callers },
        { dropInDir: this.directory },
      );
    } catch (error) {
      this.callers = [];
      throw error;
    }
    this.published = true;
    this.callers = this.stopped ? [] : callers;
    this.report(problem);
  }

  private report(problem: string | null): void {
    if (this.problem === problem) return;
    this.problem = problem;
    if (problem === null) log.info({ msg: 'Stitchwire caller policy restored' });
    else log.warn({ msg: 'Stitchwire caller policy unavailable', err: problem });
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.callers = [];
    clearInterval(this.timer);
    try {
      await this.pending;
    } finally {
      if (this.published)
        await removeServiceDeclarationFile(declarationFile, { dropInDir: this.directory });
    }
  }
}
