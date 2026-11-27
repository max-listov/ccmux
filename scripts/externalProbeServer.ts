import type { CodexSession } from 'stitchkit/agent-executor/codex';
import {
  codexAppServerSocket,
  codexExecutorProfile,
  createCodexSocketDriver,
} from '../src/agent/codex/owned/rpc.ts';
import type { MachineConfig } from '../src/types.ts';

/** Open only the read-only threads created by the external status probes. */
export function externalProbeThreads(machine: MachineConfig, cwd: string) {
  const driver = createCodexSocketDriver(codexAppServerSocket(machine), {
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions:
      'Follow the lifecycle test prompt. Do not modify files or use the network. Return a short final answer.',
  });
  const sessions = new Map<string, CodexSession>();
  return {
    async open() {
      const session = await driver.open({ profile: codexExecutorProfile(machine), cwd });
      sessions.set(session.nativeThreadId, session);
      return session;
    },
    get(threadId: string) {
      const session = sessions.get(threadId);
      if (session === undefined) throw new Error('Unknown test thread');
      return session;
    },
    async close() {
      await Promise.all([...sessions.values()].map((session) => session.close()));
    },
  };
}
