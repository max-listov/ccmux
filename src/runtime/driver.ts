import { runClaudeNativeProcess } from '../agent/claude/native/process.ts';
import { resolveAgentSdk } from '../agent/claude/native/resolve.ts';
import { preflightOwnedCodex } from '../agent/codex/ownedLaunch.ts';
import { runOwnedCodexProcess } from '../agent/codex/ownedProcess.ts';
import { runCustomProcess } from '../agent/custom/process.ts';
import { runOpenCodeProcess } from '../agent/opencode/process.ts';
import { preflightOpenCode } from '../agent/opencode/server.ts';
import type { MachineConfig, Session } from '../types.ts';
import { hasNativeRuntime } from './capabilities.ts';

export interface ManagedRuntimeDriver {
  preflight(machine: MachineConfig, flags: readonly string[]): void;
  run(
    machine: MachineConfig,
    session: Session,
    promote?: (session: Session) => Promise<Session>,
  ): Promise<void>;
}

const drivers: Partial<Record<Session['agent'], ManagedRuntimeDriver>> = {
  claude: {
    preflight: (m) => {
      const resolved = resolveAgentSdk(m);
      // Refused here, before anything durable exists, so a host that cannot run the mode never
      // acquires a session that reports itself broken.
      if ('unavailable' in resolved) throw new Error(resolved.detail);
    },
    run: runClaudeNativeProcess,
  },
  custom: {
    preflight: (_m, flags) => {
      if (flags.length) throw new Error('Custom requires typed host configuration');
    },
    run: runCustomProcess,
  },
  codex: {
    preflight: preflightOwnedCodex,
    run: (m, s, promote) =>
      runOwnedCodexProcess(
        m,
        s,
        promote === undefined ? undefined : (uuid) => promote({ ...s, uuid }),
      ),
  },
  opencode: {
    preflight: (m, flags) => {
      if (flags.length)
        throw new Error('OpenCode native launch accepts typed configuration, not caller flags');
      preflightOpenCode(m);
    },
    run: runOpenCodeProcess,
  },
};

export function nativeDriver(
  session: Pick<Session, 'agent' | 'runtime'>,
): ManagedRuntimeDriver | null {
  if (!hasNativeRuntime(session)) return null;
  const driver = drivers[session.agent];
  if (!driver) throw new Error('Native runtime driver is unavailable');
  return driver;
}
