import { join } from 'node:path';
import { dependencies } from '../../../package.json';
import { withDirectoryLock } from '../../config/registryLock.ts';
import { loadSessions } from '../../config/sessions.ts';
import { promptInvocation } from '../../env.ts';
import { recordRuntimeDiagnostic } from '../../runtime/diagnostics.ts';
import { seedNativeSelection } from '../../runtime/selection.ts';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { log } from '../../util/log.ts';
import { privateRuntimeDirectory } from '../codex/ownedPaths.ts';
import { computeStamp } from '../launchStamp.ts';
import { writeLaunchStamp } from '../sessionStatus.ts';
import { customModel, prepareCustomHost } from './host.ts';
import { CustomOwner } from './owner.ts';

export const CUSTOM_ENGINE_VERSION = `stitchkit-${dependencies.stitchkit}`;

export async function runCustomProcess(
  m: MachineConfig,
  initial: Session,
  promote?: (session: Session) => Promise<Session>,
): Promise<void> {
  const root = managedRuntimeRoot(m, initial);
  privateRuntimeDirectory(root);
  await withDirectoryLock(
    join(root, 'owner.lock'),
    async () => {
      const host = prepareCustomHost(m, initial);
      if (!initial.registrationGeneration || initial.applicationPolicy !== undefined)
        throw new Error('Custom requires a managed registration and a host composition recipe');
      const session: Session = {
        ...initial,
        nativeSession: initial.nativeSession ?? {
          runtime: 'custom',
          id: initial.registrationGeneration,
          version: CUSTOM_ENGINE_VERSION,
        },
      };
      if (session.nativeSession?.runtime !== 'custom')
        throw new Error('Custom continuation identity differs');
      const model = customModel(host.config, session.modelSelection).selection;
      await seedNativeSelection(m, session, { runtime: 'custom', model });
      const abort = new AbortController();
      const stop = () => abort.abort();
      const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
      for (const signal of signals) process.once(signal, stop);
      const owner = new CustomOwner(m, session, (error) =>
        recordRuntimeDiagnostic(m, session.name, 'custom-runtime', error),
      );
      try {
        await owner.open();
        if (promote) await promote(session);
        writeLaunchStamp(session.name, computeStamp(session, m, promptInvocation()));
        while (!abort.signal.aborted) {
          const current = loadSessions(m).find((row) => row.name === session.name);
          if (
            !current ||
            current.archived ||
            current.uuid !== session.uuid ||
            current.registrationGeneration !== session.registrationGeneration ||
            current.nativeSession?.id !== session.nativeSession?.id
          )
            throw new Error('Custom registration changed while its writer was alive');
          await owner.tick();
          await Bun.sleep(100);
        }
      } catch (error) {
        await recordRuntimeDiagnostic(m, session.name, 'custom-runtime', error);
        log.error({ msg: 'managed Custom runtime failed', name: session.name });
        throw new Error(`Custom runtime failed; run \`ccmux logs ${session.name}\` for the cause`);
      } finally {
        try {
          await owner.close();
        } finally {
          for (const signal of signals) process.removeListener(signal, stop);
        }
      }
    },
    'native runtime owner',
  );
}
