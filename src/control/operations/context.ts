import type { BoundedAdmission } from 'stitchkit/application';
import type { ExternalStatusPublisher } from '../../external/residentPublisher.ts';
import type { CreateManagedInput } from '../../session/create.ts';
import type { MachineConfig, Session } from '../../types.ts';
import type { HostCatalogCache } from '../modelCatalogCache.ts';
import type { ControlPublisher } from '../publisher.ts';

export type ControlOperationDependencies = {
  createManagedSession?: (machine: MachineConfig, input: CreateManagedInput) => Promise<Session>;
  assertExternalConfig?: () => void;
};

/** What every group of operations shares: the machine, the publishers, and the admissions created
 *  once for all of them — so a transport added later cannot add capacity or a second writer. */
export interface OperationContext {
  m: MachineConfig;
  publisher: ControlPublisher;
  external: ExternalStatusPublisher;
  mutations: BoundedAdmission;
  waits: BoundedAdmission;
  reads: BoundedAdmission;
  catalog: HostCatalogCache;
  dependencies: ControlOperationDependencies;
}
