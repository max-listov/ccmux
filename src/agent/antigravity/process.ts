import { join } from 'node:path';
import { isAntigravityProfileBinding } from '../../config/antigravityProfileSchema.ts';
import { recordRuntimeDiagnostic } from '../../runtime/diagnostics.ts';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import { privateRuntimeDirectory } from '../../runtime/store.ts';
import { nativeRuntimeWake } from '../../runtime/wake.ts';
import { loadSessions } from '../../session/registry.ts';
import { writeLaunchStamp } from '../../session/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { promptInvocation } from '../../util/env.ts';
import { withLock } from '../../util/lock.ts';
import { log } from '../../util/log.ts';
import { verifySessionProfile } from '../claude/namedProfiles.ts';
import { computeStamp } from '../launch/launchStamp.ts';
import { antigravityLaunchOptions } from './namedProfiles.ts';
import { AntigravityOwner } from './owner.ts';
import {
  ANTIGRAVITY_MIN_VERSION,
  ANTIGRAVITY_MULTIPROFILE_MIN_VERSION,
  preflightAntigravity,
} from './preflight.ts';

/**
 * The pane process that owns one Antigravity ACP conversation.
 *
 * Mirrors the other native owners (`runClaudeNativeProcess`, `runCustomProcess`): holds
 * `owner.lock`, promotes the real provider `nativeSession.id` on first admission, writes the
 * launch stamp, and exits non-zero if the ACP worker dies so the supervisor can heal and resume it.
 */
export async function runAntigravityProcess(
  m: MachineConfig,
  initial: Session,
  promote?: (session: Session) => Promise<Session>,
): Promise<void> {
  verifySessionProfile(m, initial);
  const binding = isAntigravityProfileBinding(initial.profile) ? initial.profile : undefined;
  const launch = antigravityLaunchOptions(m, binding);
  await preflightAntigravity(m, initial.flags, {
    minVersion: launch.forceFileStorage
      ? ANTIGRAVITY_MULTIPROFILE_MIN_VERSION
      : ANTIGRAVITY_MIN_VERSION,
    dataDir: launch.dataDir,
  });
  const root = managedRuntimeRoot(m, initial);
  privateRuntimeDirectory(root);
  await withLock(
    join(root, 'owner.lock'),
    async () => {
      if (!initial.registrationGeneration)
        throw new Error('Antigravity runtime requires a managed registration');
      if (initial.nativeSession && initial.nativeSession.runtime !== 'antigravity')
        throw new Error('Antigravity continuation identity differs');
      const abort = new AbortController();
      const wake = nativeRuntimeWake(m, initial, abort.signal);
      const stop = () => abort.abort();
      const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
      for (const signal of signals) process.once(signal, stop);
      const owner = new AntigravityOwner(m, initial, (error) =>
        recordRuntimeDiagnostic(m, initial.name, 'antigravity-runtime', error),
      );
      try {
        await owner.open();
        const session = promote ? await promote(owner.identity) : owner.identity;
        writeLaunchStamp(session.name, computeStamp(session, m, promptInvocation()));
        while (!abort.signal.aborted) {
          if (wake.changed()) {
            const current = loadSessions(m).find((row) => row.name === session.name);
            const held = owner.identity;
            if (
              !current ||
              current.archived ||
              current.uuid !== held.uuid ||
              current.registrationGeneration !== held.registrationGeneration ||
              current.nativeSession?.id !== held.nativeSession?.id
            )
              throw new Error('Antigravity registration changed while its writer was alive');
          }
          const failure = owner.failed;
          if (failure !== null) throw failure;
          await owner.tick();
          await wake.wait();
        }
      } catch (error) {
        await recordRuntimeDiagnostic(m, initial.name, 'antigravity-runtime', error);
        log.error({ msg: 'managed Antigravity runtime failed', name: initial.name });
        throw new Error(
          `Antigravity runtime failed; run \`stitchmux logs ${initial.name}\` for the cause`,
        );
      } finally {
        wake.close();
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
