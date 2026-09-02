import { join } from 'node:path';
import { rotateChatCredential } from '../../chat/auth.ts';
import { withDirectoryLock } from '../../config/registryLock.ts';
import { loadSessions } from '../../config/sessions.ts';
import { promptInvocation } from '../../env.ts';
import { verifyApplicationPolicy } from '../../policy/resolve.ts';
import { recordRuntimeDiagnostic } from '../../runtime/diagnostics.ts';
import { ManagedRuntimeExit } from '../../runtime/exit.ts';
import { managedRuntimeRoot } from '../../runtime/status.ts';
import type { MachineConfig, Session } from '../../types.ts';
import { log } from '../../util/log.ts';
import { privateRuntimeDirectory } from '../codex/ownedPaths.ts';
import { computeStamp } from '../launchStamp.ts';
import { writeLaunchStamp } from '../sessionStatus.ts';
import { admitOpenCode } from './admission.ts';
import { OpenCodeConnection } from './connection.ts';
import { startOpenCodeServer } from './server.ts';

export async function runOpenCodeProcess(
  m: MachineConfig,
  initial: Session,
  promote?: (session: Session) => Promise<Session>,
): Promise<void> {
  if (initial.applicationPolicy !== undefined)
    verifyApplicationPolicy(m, 'opencode', initial.applicationPolicy);
  const root = managedRuntimeRoot(m, initial);
  privateRuntimeDirectory(root);
  await withDirectoryLock(
    join(root, 'owner.lock'),
    async () => {
      const abort = new AbortController();
      let stopping = false;
      const stop = () => {
        stopping = true;
        abort.abort();
      };
      const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
      for (const signal of signals) process.once(signal, stop);
      let server: Awaited<ReturnType<typeof startOpenCodeServer>> | null = null;
      let connection: OpenCodeConnection | null = null;
      let admitted = false;
      try {
        const child = await startOpenCodeServer(m, initial, abort.signal, {
          name: initial.name,
          credential: rotateChatCredential(m, initial),
        });
        server = child;
        void child.child.exited.then(() => abort.abort());
        let session = await admitOpenCode(
          m,
          initial,
          child,
          promote !== undefined,
          AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        );
        if (promote) session = await promote(session);
        admitted = true;
        writeLaunchStamp(session.name, computeStamp(session, m, promptInvocation()));
        let reconnectDelay = 250;
        while (!abort.signal.aborted) {
          const current = loadSessions(m).find((row) => row.name === session.name);
          if (
            !current ||
            current.uuid !== session.uuid ||
            current.archived ||
            current.agent !== 'opencode' ||
            current.registrationGeneration !== session.registrationGeneration ||
            current.nativeSession?.id !== session.nativeSession?.id
          )
            throw new Error('Native registration changed while its writer was alive');
          try {
            const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
            if (connection === null) {
              connection = new OpenCodeConnection(m, session, child);
              await connection.open(abort.signal);
            } else await connection.tick(signal);
            reconnectDelay = 250;
          } catch (error) {
            if (abort.signal.aborted) break;
            await recordRuntimeDiagnostic(m, session.name, 'observer', error, child.stderr());
            log.warn({
              msg: 'native observer unavailable',
              name: session.name,
              runtime: 'opencode',
            });
            await connection?.close('disconnected');
            connection = null;
            await Bun.sleep(reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
          }
          await Bun.sleep(250);
        }
        if (!stopping) throw new ManagedRuntimeExit('OpenCode provider exited after admission');
      } catch (error) {
        if (stopping) return;
        await recordRuntimeDiagnostic(m, initial.name, 'runtime', error, server?.stderr());
        log.error({
          msg: 'managed native runtime failed',
          name: initial.name,
          runtime: 'opencode',
        });
        if (admitted && server?.child.exitCode !== null)
          throw new ManagedRuntimeExit('OpenCode provider exited');
        throw new Error(`Native runtime failed; run \`ccmux logs ${initial.name}\` for the cause`);
      } finally {
        abort.abort();
        await connection?.close('stopped');
        await server?.close();
        for (const signal of signals) process.removeListener(signal, stop);
      }
    },
    'native runtime owner',
  );
}
