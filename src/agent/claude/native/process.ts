import { join } from 'node:path';
import { withDirectoryLock } from '../../../config/registryLock.ts';
import { loadSessions } from '../../../config/sessions.ts';
import { promptInvocation } from '../../../env.ts';
import { recordRuntimeDiagnostic } from '../../../runtime/diagnostics.ts';
import { managedRuntimeRoot } from '../../../runtime/status.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { log } from '../../../util/log.ts';
import { privateRuntimeDirectory } from '../../codex/ownedPaths.ts';
import { computeStamp } from '../../launchStamp.ts';
import { writeLaunchStamp } from '../../sessionStatus.ts';
import { ClaudeNativeOwner } from './owner.ts';
import { resolveAgentSdk } from './resolve.ts';

export const CLAUDE_NATIVE_VERSION = 'claude-agent-sdk';

/**
 * The pane process that owns one native Claude conversation.
 *
 * Shaped like the other native owners on purpose: the supervisor already knows how to keep this
 * alive, restart it and read what it publishes, and a runtime that invented its own lifecycle would
 * be a second thing to heal.
 */
export async function runClaudeNativeProcess(
  m: MachineConfig,
  initial: Session,
  promote?: (session: Session) => Promise<Session>,
): Promise<void> {
  const resolved = resolveAgentSdk(m);
  if ('unavailable' in resolved) throw new Error(resolved.detail);
  const root = managedRuntimeRoot(m, initial);
  privateRuntimeDirectory(root);
  await withDirectoryLock(
    join(root, 'owner.lock'),
    async () => {
      if (!initial.registrationGeneration)
        throw new Error('Native Claude requires a managed registration');
      const session: Session = {
        ...initial,
        nativeSession: initial.nativeSession ?? {
          runtime: 'claude',
          // The registration generation is the conversation's identity here, which keeps it out of
          // the pinned-uuid space the interactive mode's fork detection walks.
          id: initial.registrationGeneration,
          version: CLAUDE_NATIVE_VERSION,
        },
      };
      if (session.nativeSession?.runtime !== 'claude')
        throw new Error('Native Claude continuation identity differs');
      const abort = new AbortController();
      const stop = () => abort.abort();
      const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
      for (const signal of signals) process.once(signal, stop);
      const owner = new ClaudeNativeOwner(m, session, (error) =>
        recordRuntimeDiagnostic(m, session.name, 'claude-native-runtime', error),
      );
      try {
        await owner.open();
        // The owner may have resolved a different conversation than the one this process assumed —
        // a fork destination continues the id `forkSession` returned. Promoting the assumed identity
        // would record a session pointing at a conversation nobody is writing.
        if (promote) await promote(owner.identity);
        writeLaunchStamp(session.name, computeStamp(owner.identity, m, promptInvocation()));
        while (!abort.signal.aborted) {
          const current = loadSessions(m).find((row) => row.name === session.name);
          // Compared against what the owner RESOLVED, not against what this process assumed: after a
          // fork those differ, and comparing the assumption would declare the registration changed
          // on the very first pass of a conversation this process had just correctly adopted.
          const held = owner.identity;
          if (
            !current ||
            current.archived ||
            current.uuid !== held.uuid ||
            current.registrationGeneration !== held.registrationGeneration ||
            current.nativeSession?.id !== held.nativeSession?.id
          )
            throw new Error('Native Claude registration changed while its writer was alive');
          // A runtime that ended is a failure of this process, not a state to keep publishing.
          // Without this the loop went on writing `connected: true` with a fresh lease every tick
          // over a conversation whose runtime was gone, and nothing ever restarted it.
          const failure = owner.failed;
          if (failure !== null) throw failure;
          await owner.tick();
          await Bun.sleep(200);
        }
      } catch (error) {
        await recordRuntimeDiagnostic(m, session.name, 'claude-native-runtime', error);
        log.error({ msg: 'managed native Claude runtime failed', name: session.name });
        throw new Error(
          `Native Claude runtime failed; run \`ccmux logs ${session.name}\` for the cause`,
        );
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
