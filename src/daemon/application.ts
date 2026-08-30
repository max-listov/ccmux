import {
  type ApplicationHandle,
  createApplication,
  createManagedSchedule,
  defineManagedResource,
  managedServerResource,
} from 'stitchkit/application';
import { deliverPending } from '../chat/deliver.ts';
import { mirrorPending } from '../chat/telegram.ts';
import { cmdEnsure } from '../commands/ensure.ts';
import { autoUpdateOnce } from '../commands/update.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { BOOT_ATTEMPTS } from '../config/paths.ts';
import { ControlPublisher } from '../control/publisher.ts';
import { createControlServer } from '../control/server.ts';
import { IS_DEV } from '../env.ts';
import { type Observed, observeOnce } from '../events/observe.ts';
import { ExternalStatusObserver } from '../external/resident-observer.ts';
import { ExternalStatusPublisher } from '../external/resident-publisher.ts';
import { EXTERNAL_INTERVAL_MS } from '../external/resident-schema.ts';
import { flushOutbox } from '../fleet/flush.ts';
import { MonitoringPublisher } from '../monitoring/publish.ts';
import { STATUS_INTERVAL_MS } from '../monitoring/schema.ts';
import { type OwnedRuntimeJournal, openOwnedRuntimeJournal } from '../runtime/journalOwner.ts';
import type { MachineConfig } from '../types.ts';
import { clearBootGuard } from '../util/bootGuard.ts';
import { log, setLogLevel } from '../util/log.ts';

/** The daemon owns these resources, not the independently supervised provider writers. */
export function createDaemonApplication(initial: MachineConfig) {
  let journal: OwnedRuntimeJournal | undefined;
  const chronology = defineManagedResource({
    id: 'diagnostic-journal',
    start: async () => {
      journal = await openOwnedRuntimeJournal(initial, { kind: 'daemon' });
      journal.submit({
        at: new Date().toISOString(),
        runtime: 'daemon',
        kind: journal.recovered ? 'recovery' : 'started',
      });
      return { value: journal };
    },
    close: async () => {
      journal?.submit({ at: new Date().toISOString(), runtime: 'daemon', kind: 'stopped' });
      await journal?.close();
    },
  });
  const monitoring = new MonitoringPublisher();
  const publisher = new ControlPublisher(initial);
  const external = new ExternalStatusPublisher(initial.rcPrefix);
  const externalObserver = new ExternalStatusObserver(initial, external);
  const previous = new Map<string, Observed>();
  const machine = loadMachineConfig;
  const projection = defineManagedResource({
    id: 'projection',
    dependsOn: [chronology],
    start: () => ({ value: publisher }),
    stopAdmission: () => publisher.close(),
    close: () => {
      publisher.close();
      monitoring.stop();
    },
  });
  let closeAudit = async (): Promise<void> => {};
  const externalOwner = defineManagedResource({
    id: 'external-status',
    start: () => ({ value: externalObserver }),
    stopAdmission: () => external.close(),
    close: () => externalObserver.close(),
  });
  const controlOwner = defineManagedResource({
    id: 'control-owner',
    dependsOn: [projection, externalOwner, chronology],
    start: (ctx) => {
      const owned = createControlServer(
        initial,
        ctx.use(projection),
        application.admission,
        machine,
        external,
      );
      closeAudit = async () => {
        await owned.observability.close();
      };
      return { value: owned };
    },
    close: () => closeAudit(),
  });
  const control = managedServerResource({
    id: 'control',
    dependsOn: [controlOwner],
    server: (ctx) => ctx.use(controlOwner).server,
  });
  const observation = createManagedSchedule({
    id: 'observation',
    dependsOn: [projection.id],
    everyMs: STATUS_INTERVAL_MS,
    startAfterMs: 0,
    overlap: { mode: 'skip' },
    run: async ({ signal }) => {
      const m = machine();
      monitoring.begin(m);
      await observeOnce(m, previous, Date.now(), monitoring.sample);
      signal.throwIfAborted();
      const snapshot = await monitoring.publish(m);
      await journal?.publishStatus();
      // The existing monitoring file follows configuration changes. A bound IPC listener
      // cannot change its address in place: its clients must reconnect after a restart.
      if (m.stateDir !== initial.stateDir || m.rcPrefix !== initial.rcPrefix)
        publisher.unavailable('config-changed');
      else publisher.publish(m, snapshot);
    },
    onError: (error) => {
      journal?.submit({
        at: new Date().toISOString(),
        runtime: 'daemon',
        kind: 'observer-gap',
        outcome: 'unavailable',
      });
      publisher.unavailable('observation-failed');
      log.warn({ msg: 'session event pass failed', err: String(error) });
    },
  });
  const freshness = createManagedSchedule({
    id: 'freshness',
    dependsOn: [projection.id],
    everyMs: 250,
    overlap: { mode: 'skip' },
    run: () => {
      publisher.expire();
      external.expire();
    },
  });
  const externalObservation = createManagedSchedule({
    id: 'external-observation',
    dependsOn: [externalOwner.id],
    everyMs: EXTERNAL_INTERVAL_MS,
    startAfterMs: 0,
    overlap: { mode: 'skip' },
    run: ({ signal }) => externalObserver.refresh(machine(), signal),
    onError: (error) => {
      external.unavailable('invalid-response');
      log.warn({ msg: 'external observation failed', err: String(error) });
    },
  });
  const delivery = createManagedSchedule({
    id: 'delivery',
    everyMs: 3000,
    startAfterMs: 0,
    overlap: { mode: 'skip' },
    run: async ({ signal }) => {
      const m = machine();
      signal.throwIfAborted();
      await deliverPending(m);
      signal.throwIfAborted();
      await mirrorPending(m);
      signal.throwIfAborted();
      await flushOutbox(m);
    },
    onError: (error) => log.warn({ msg: 'chat delivery pass failed', err: String(error) }),
  });
  let nextEnsureAt = 0;
  let lastUpdateCheck = 0;
  let guardCleared = false;
  const healing = createManagedSchedule({
    id: 'healing',
    everyMs: 1000,
    startAfterMs: 0,
    overlap: { mode: 'skip' },
    run: async ({ signal }) => {
      if (Date.now() < nextEnsureAt) return;
      const m = machine();
      setLogLevel(m.logLevel);
      try {
        try {
          await cmdEnsure();
          if (!IS_DEV && !guardCleared) {
            clearBootGuard(BOOT_ATTEMPTS);
            guardCleared = true;
          }
        } catch (error) {
          log.error({ msg: 'ensure pass failed', err: String(error) });
        }
        signal.throwIfAborted();
        if (m.autoUpdate && Date.now() - lastUpdateCheck >= m.updateCheckInterval * 1000) {
          lastUpdateCheck = Date.now();
          if (await autoUpdateOnce(m)) {
            // The next event-loop turn follows this schedule's promise settlement. Signal the
            // normal shutdown path; the boot unit restarts exit 143. Never wait for our own exit.
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 0);
          }
        }
      } finally {
        nextEnsureAt = Date.now() + m.ensureInterval * 1000;
      }
    },
    onError: (error) =>
      log.warn({ msg: 'config re-read / auto-update failed', err: String(error) }),
  });
  const application: ApplicationHandle = createApplication({
    id: 'ccmux-daemon',
    resources: [
      chronology,
      projection,
      externalOwner,
      controlOwner,
      control,
      observation,
      externalObservation,
      freshness,
      delivery,
      healing,
    ],
    shutdown: { gracePeriodMs: 5000, forceTimeoutMs: 2000 },
    onResourceFailure: ({ resourceId, phase, error }) =>
      log.error({ msg: 'daemon resource failed', resourceId, phase, err: String(error) }),
  });
  return {
    application,
    publisher,
    external,
    externalObserver,
    monitoring,
    schedules: { observation, externalObservation, freshness, delivery, healing },
  };
}
