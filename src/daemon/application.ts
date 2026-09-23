import {
  type ApplicationHandle,
  createApplication,
  createManagedSchedule,
  defineManagedResource,
  lifecycleLedgerResource,
  managedServerResource,
} from 'stitchkit/application';
import { pruneTranscriptIndexes } from '../agent/transcript/transcriptIndex.ts';
import { CursorsUnreadableError } from '../chat/cursors.ts';
import { deliverPending } from '../chat/deliver.ts';
import { mirrorPending } from '../chat/telegram.ts';
import { settleUndeliverable } from '../chat/undeliverable.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { BOOT_ATTEMPTS } from '../config/paths.ts';
import { ControlPublisher } from '../control/publisher.ts';
import { ControlModelsReadSchema } from '../control/schema/model.ts';
import { createControlServer } from '../control/transport/server.ts';
import { InventoryPublisher } from '../events/inventory.ts';
import { type Observed, observeOnce } from '../events/observe.ts';
import { ExternalStatusObserver } from '../external/residentObserver.ts';
import { ExternalStatusPublisher } from '../external/residentPublisher.ts';
import { EXTERNAL_INTERVAL_MS } from '../external/residentSchema.ts';
import { flushOutbox } from '../fleet/flush.ts';
import { MonitoringPublisher } from '../monitoring/publish.ts';
import { STATUS_INTERVAL_MS } from '../monitoring/schema.ts';
import { autoUpdateOnce } from '../release/update.ts';
import { type OwnedRuntimeJournal, openOwnedRuntimeJournal } from '../runtime/journalOwner.ts';
import { healOnce } from '../session/heal.ts';
import type { MachineConfig } from '../types.ts';
import { createUsageObservation } from '../usage/observation.ts';
import { clearBootGuard } from '../util/bootGuard.ts';
import { IS_DEV } from '../util/env.ts';
import { log, setLogLevel } from '../util/log.ts';
import { VERSION } from '../util/version.ts';
import { createDaemonLifecycle } from './lifecycle.ts';
import { watchLoopStalls } from './loopStall.ts';

/** The daemon owns these resources, not the independently supervised provider writers. */
export function createDaemonApplication(initial: MachineConfig) {
  let journal: OwnedRuntimeJournal | undefined;
  const chronology = defineManagedResource({
    id: 'diagnostic-journal',
    start: async () => {
      journal = await openOwnedRuntimeJournal(initial, { kind: 'daemon' });
      return { value: journal };
    },
    close: async () => {
      await journal?.close();
    },
  });
  const lifecycle = createDaemonLifecycle(initial);
  lifecycle.subscribe((fact) => {
    log.info({ msg: 'daemon lifecycle', ...fact });
    journal?.submit({
      runtime: 'daemon',
      generation: fact.runId,
      at:
        fact.type === 'started'
          ? fact.startedAt
          : fact.type === 'ready'
            ? fact.readyAt
            : fact.stoppedAt,
      kind:
        fact.type === 'ready'
          ? 'bound'
          : fact.type === 'started' && fact.previousExit === 'abnormal'
            ? 'recovery'
            : fact.type,
    });
  });
  const processLifecycle = {
    ...lifecycleLedgerResource(lifecycle, { id: 'process-lifecycle', version: VERSION }),
    dependsOn: [chronology],
  };
  const monitoring = new MonitoringPublisher();
  const inventory = new InventoryPublisher();
  const publisher = new ControlPublisher(initial);
  const external = new ExternalStatusPublisher(initial.rcPrefix);
  const externalObserver = new ExternalStatusObserver(initial, external);
  const previous = new Map<string, Observed>();
  const machine = loadMachineConfig;
  const usageObservation = createUsageObservation(machine, external);
  const projection = defineManagedResource({
    id: 'projection',
    dependsOn: [chronology, processLifecycle],
    start: () => ({ value: publisher }),
    stopAdmission: () => publisher.close(),
    close: () => {
      publisher.close();
      monitoring.stop();
      inventory.stop();
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
      // Read once at start, so the first caller after a restart finds a catalog instead of a cold
      // metadata App Server; later reads happen when a caller finds the copy old.
      if (initial.codexBin && initial.codexHome)
        void owned.controls.catalog.refresh(ControlModelsReadSchema.parse({})).catch(() => {});
      closeAudit = async () => {
        owned.controls.catalog.close();
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
      inventory.begin(m);
      await observeOnce(m, previous, Date.now(), (m, s, startedAt, pane, seen) => {
        const row = monitoring.sample(m, s, startedAt, pane, seen);
        if (row !== null) inventory.sample(m, s, row, startedAt);
      });
      signal.throwIfAborted();
      const snapshot = await monitoring.publish(m);
      await inventory.publish(m, m.sessionEvents);
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
  // Held delivery is a condition, not an event: said when it starts, changes and ends — not every
  // three seconds while it lasts.
  let heldBy: string | null = null;
  const delivery = createManagedSchedule({
    id: 'delivery',
    everyMs: 3000,
    startAfterMs: 0,
    overlap: { mode: 'skip' },
    run: async ({ signal }) => {
      const m = machine();
      signal.throwIfAborted();
      let held: string | null = null;
      try {
        // Before delivery, because delivery walks the live sessions and would never look at these:
        // a letter whose recipient is gone is closed here or it waits in the queue for ever.
        await settleUndeliverable(m);
        signal.throwIfAborted();
        await deliverPending(m);
        signal.throwIfAborted();
        await mirrorPending(m);
      } catch (error) {
        if (!(error instanceof CursorsUnreadableError)) throw error;
        held = error.message;
        if (heldBy !== held) log.error({ msg: held, path: error.path });
      }
      if (heldBy !== null && held === null)
        log.info({ msg: 'chat delivery resumed — cursors readable again' });
      heldBy = held;
      signal.throwIfAborted();
      // Outbound mail does not depend on the cursors, so a held inbound side does not hold it.
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
          await healOnce();
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
  let stopLoopWatch = (): void => {};
  const loopStalls = defineManagedResource({
    id: 'loop-stall-watch',
    start: () => {
      stopLoopWatch = watchLoopStalls((stall) =>
        log.warn({ msg: 'daemon event loop blocked', ...stall }),
      );
      return { value: null };
    },
    close: () => stopLoopWatch(),
  });
  // The transcript index cache otherwise only grows: every transcript ever read keeps an index, and
  // nothing removed one whose transcript was gone. Once a day, and first a minute after start.
  const cachePrune = createManagedSchedule({
    id: 'cache-prune',
    everyMs: 24 * 60 * 60 * 1000,
    startAfterMs: 60_000,
    overlap: { mode: 'skip' },
    run: async () => {
      const { removed, bytes } = await pruneTranscriptIndexes();
      if (removed > 0)
        log.info({
          msg: 'transcript index cache pruned',
          removed,
          megabytes: Math.round(bytes / 2 ** 20),
        });
    },
    onError: (error) => log.warn({ msg: 'transcript index prune failed', err: String(error) }),
  });
  const application: ApplicationHandle = createApplication({
    id: 'ccmux-daemon',
    resources: [
      loopStalls,
      chronology,
      processLifecycle,
      projection,
      externalOwner,
      controlOwner,
      control,
      observation,
      usageObservation,
      externalObservation,
      freshness,
      delivery,
      healing,
      cachePrune,
    ],
    shutdown: { gracePeriodMs: 5000, forceTimeoutMs: 2000 },
    onResourceFailure: ({ resourceId, phase, error }) =>
      log.error({ msg: 'daemon resource failed', resourceId, phase, err: String(error) }),
  });
  return {
    application,
    lifecycle,
    publisher,
    external,
    externalObserver,
    monitoring,
    schedules: { observation, usageObservation, externalObservation, freshness, delivery, healing },
  };
}
