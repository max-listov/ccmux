import { AppError } from 'stitchkit';
import {
  commandText,
  readClaudeCommands,
  resolveCommand,
} from '../agent/claude/native/commands.ts';
import { withNativeAdmission } from '../runtime/admission.ts';
import { runtimeCapabilities } from '../runtime/capabilities.ts';
import { readRuntimeInput, runtimeInputId, writeRuntimeInput } from '../runtime/input.ts';
import { requestRuntimeMcp } from '../runtime/mcpControl.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { PermissionMode } from '../runtime/projectionSchema.ts';
import { requestRuntimeRewind } from '../runtime/rewind.ts';
import { requestRuntimeMode } from '../runtime/sessionMode.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import type { MachineConfig, ManagedPeer } from '../types.ts';
import { requireNativeIdle } from './selection.ts';
import { controlTarget } from './target.ts';

/**
 * A slash command is a turn, not a message.
 *
 * It goes into the same runtime mailbox a message uses — one writer, one durable receipt, one turn
 * lifecycle — but it never passes through the chat ledger, because ledger delivery frames every
 * message with its sender attribution and a command carrying that prefix is no longer a command.
 */
export function readControlCommands(m: MachineConfig, target: ManagedPeer) {
  const session = controlTarget(m, target);
  return { target, data: readClaudeCommands(m, session) };
}

export async function runControlCommand(
  m: MachineConfig,
  input: { target: ManagedPeer; command: string; args?: string | undefined; operationId: string },
  signal: AbortSignal,
) {
  const session = controlTarget(m, input.target);
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'This runtime does not accept commands', 409);
  const commands = readClaudeCommands(m, session);
  const command = resolveCommand(commands, input.command);
  if (command === undefined)
    // Refused against what the runtime published, exactly as a model or an effort is: a command it
    // never named would be delivered as ordinary text and answered as if someone had asked about it.
    throw new AppError('UNSUPPORTED', 'This runtime does not offer that command', 409);
  const text = commandText(command, input.args);
  return withNativeAdmission(m, session, async () => {
    signal.throwIfAborted();
    const prior = readRuntimeInput(m, session);
    if (prior?.messageId === input.operationId)
      // A retry of the same operation is the same turn, never a second one.
      return {
        target: input.target,
        accepted: true as const,
        turnId: prior.nativeId,
        text: prior.text,
      };
    requireNativeIdle(m, session);
    const read = readManagedRuntimeStatus(m, session);
    if (read.status !== 'live' || !read.snapshot)
      throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
    const nativeId = runtimeInputId(session, input.operationId, Date.now());
    await writeRuntimeInput(m, session, {
      messageId: input.operationId,
      nativeId,
      text,
      phase: 'queued',
      kind: 'command',
    });
    return { target: input.target, accepted: true as const, turnId: nativeId, text };
  });
}

export async function setControlPermissionMode(
  m: MachineConfig,
  input: { target: ManagedPeer; mode: PermissionMode; operationId: string },
  signal: AbortSignal,
) {
  const session = controlTarget(m, input.target);
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'This runtime does not expose its permission mode', 409);
  const mode = await requestRuntimeMode(m, session, input, signal);
  return { target: input.target, mode };
}

export async function rewindControlFiles(
  m: MachineConfig,
  input: { target: ManagedPeer; messageId: string; dryRun: boolean; operationId: string },
  signal: AbortSignal,
) {
  const session = controlTarget(m, input.target);
  if (!runtimeCapabilities(session).fileCheckpoints)
    throw new AppError('UNSUPPORTED', 'This runtime cannot rewind files', 409);
  const result = await requestRuntimeRewind(m, session, input, signal);
  return { target: input.target, dryRun: input.dryRun, result };
}

export function readControlMcpServers(m: MachineConfig, target: ManagedPeer) {
  const session = controlTarget(m, target);
  const read = readManagedRuntimeStatus(m, session);
  if (read.status !== 'live' || !read.snapshot)
    throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
  const servers = read.snapshot.mcpServers;
  if (servers === undefined)
    // Not the same as a session with no servers: one is a runtime that does not report them, and
    // an empty list would state a fact nobody established.
    throw new AppError('UNSUPPORTED', 'This runtime does not report its MCP servers', 409);
  return { target, data: servers };
}

export async function controlMcpServer(
  m: MachineConfig,
  input: {
    target: ManagedPeer;
    server: string;
    action: 'enable' | 'disable' | 'reconnect';
    operationId: string;
  },
  signal: AbortSignal,
) {
  const session = controlTarget(m, input.target);
  if (!runtimeCapabilities(session).mcpControl)
    throw new AppError('UNSUPPORTED', 'This runtime does not expose its MCP servers', 409);
  const result = await requestRuntimeMcp(m, session, input, signal);
  return { target: input.target, ...result };
}
