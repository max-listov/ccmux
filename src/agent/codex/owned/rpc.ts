import { join } from 'node:path';
import type { ExecutorProfileConfig } from 'stitchkit/agent-executor';
import {
  type CodexControlConnection,
  type CodexDriver,
  type CodexDriverConfig,
  type CodexNotificationEvent,
  type CodexServerRequestEvent,
  CodexUnixSocketError,
  type CodexUnixSocketErrorKind,
  createCodexDriver,
} from 'stitchkit/agent-executor/codex';
import type { MachineConfig, Session } from '../../../types.ts';
import { HOME } from '../../../util/home.ts';
import { codexProfile } from '../profileRoot.ts';
import { ownedCodexSocket } from './paths.ts';

export type CodexRpcId = number | string;
export interface CodexRpcEvent {
  readonly method: string;
  readonly params: unknown;
}
export interface CodexRpcRequest extends CodexRpcEvent {
  readonly id: CodexRpcId;
}

export type CodexAppFailureKind =
  | 'endpoint-absent'
  | 'endpoint-not-listening'
  | 'upgrade-refused'
  | 'connection-lost';

/** Map Stitchkit's Unix socket error kinds to stitchmux's public diagnostic classification. */
export function codexFailureKind(kind: CodexUnixSocketErrorKind): CodexAppFailureKind {
  return kind === 'target-refused' ? 'endpoint-not-listening' : kind;
}

export function codexFailureKindOf(error: unknown): CodexAppFailureKind | null {
  if (error instanceof CodexUnixSocketError) return codexFailureKind(error.kind);
  return null;
}

export interface CodexControlConnectOptions {
  signal?: AbortSignal;
  maxFrameBytes?: number;
  onNotification?: (event: CodexNotificationEvent) => void;
  onServerRequest?: (event: CodexServerRequestEvent) => void;
  onDisconnect?: (error: Error) => void;
}

export const OWNED_CODEX_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export function codexExecutorProfile(
  m: Pick<MachineConfig, 'codexHome'>,
  session?: Pick<Session, 'envFile' | 'dir'>,
): ExecutorProfileConfig {
  const home =
    session === undefined
      ? (m.codexHome ?? join(HOME, '.codex'))
      : (codexProfile(session, m).codexHome ?? join(HOME, '.codex'));
  return {
    engine: 'codex',
    profileId: 'local',
    home,
  };
}

export function createCodexSocketDriver(
  socketPath: string,
  options: Omit<CodexDriverConfig, 'transport'> = {},
): CodexDriver {
  return createCodexDriver({
    ...options,
    transport: { kind: 'unix-connect', socketPath },
  });
}

export function connectCodexSocketControl(
  socketPath: string,
  profile: ExecutorProfileConfig,
  cwd: string,
  options: CodexControlConnectOptions = {},
): Promise<CodexControlConnection> {
  const driver = createCodexSocketDriver(socketPath, {
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
  });
  return driver.connectControl({
    profile,
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export function connectOwnedCodex(
  m: MachineConfig,
  s: Pick<Session, 'name' | 'dir' | 'envFile'>,
  options: CodexControlConnectOptions = {},
): Promise<CodexControlConnection> {
  return connectCodexSocketControl(ownedCodexSocket(m, s.name), codexExecutorProfile(m, s), s.dir, {
    ...options,
    maxFrameBytes: options.maxFrameBytes ?? OWNED_CODEX_MAX_FRAME_BYTES,
  });
}

export function codexAppServerSocket(m: MachineConfig): string {
  if (!m.codexHome) throw new Error('Codex home is not configured');
  return join(m.codexHome, 'app-server-control', 'app-server-control.sock');
}

export async function connectCodexAppServerControl(
  m: MachineConfig,
  options: CodexControlConnectOptions = {},
): Promise<CodexControlConnection> {
  const profile = codexExecutorProfile(m);
  return connectCodexSocketControl(codexAppServerSocket(m), profile, profile.home, options);
}
