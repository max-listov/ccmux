import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { hasNativeRuntime } from '../../../runtime/modes.ts';

import { managedRuntimeRoot, readManagedRuntimeStatus } from '../../../runtime/status.ts';
import { readPrivateJson } from '../../../runtime/store.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { atomicWrite } from '../../../util/atomic.ts';
import { type ControlCommand, ControlCommandSchema } from './commandSchema.ts';

/**
 * The slash commands this session's runtime offers, published by the writer that can ask.
 *
 * Same shape and same reason as the model catalog: only the owner process holds a connection, so a
 * reader elsewhere would have to invent the list. What a caller may run is decided against this
 * file, so a command the runtime never named is refused instead of being sent and silently read as
 * ordinary text.
 */

const PreparedSchema = z
  .object({
    registrationGeneration: z.uuid(),
    commands: z.array(ControlCommandSchema).max(512),
  })
  .strict();
const MAX_BYTES = 512 * 1024;
const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'commands.json');

/** What the runtime reported about a command, kept to the fields a caller needs. */
export interface SupportedCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: readonly string[];
}

export function claudeCommands(commands: readonly SupportedCommand[]): ControlCommand[] {
  return commands.slice(0, 512).map((command) => ({
    // Without the leading slash, exactly as the runtime names it: the slash is how the command is
    // WRITTEN, not part of its identity, and storing both spellings invites matching on the wrong one.
    name: command.name.replace(/^\//, '').slice(0, 128),
    description: (command.description ?? '').slice(0, 1_024),
    argumentHint: (command.argumentHint ?? '').slice(0, 256),
    aliases: (command.aliases ?? []).slice(0, 16).map((alias) => alias.replace(/^\//, '')),
  }));
}

export async function writeClaudeCommands(
  m: MachineConfig,
  s: Session,
  commands: readonly ControlCommand[],
): Promise<void> {
  const bytes = JSON.stringify(
    PreparedSchema.parse({ registrationGeneration: s.registrationGeneration, commands }),
  );
  if (Buffer.byteLength(bytes) > MAX_BYTES)
    throw new Error('Native Claude command catalog exceeds its bounded projection');
  await atomicWrite(path(m, s), bytes, 0o600);
}

export function readClaudeCommands(m: MachineConfig, session: Session): ControlCommand[] {
  if (!hasNativeRuntime(session))
    throw new AppError('UNSUPPORTED', 'This runtime does not expose a command catalog', 409);
  const prepared = readPrivateJson(path(m, session), PreparedSchema, MAX_BYTES);
  if (
    prepared === null ||
    prepared.registrationGeneration !== session.registrationGeneration ||
    readManagedRuntimeStatus(m, session).status !== 'live'
  )
    throw new AppError('UNAVAILABLE', 'Native runtime command catalog is unavailable', 503);
  return prepared.commands;
}

/**
 * Resolve what a caller asked to run against what the runtime published.
 *
 * An alias resolves to its command, because a runtime that names `/cost` and `/usage` as one thing
 * would otherwise have half its own vocabulary refused.
 */
export function resolveCommand(
  commands: readonly ControlCommand[],
  requested: string,
): ControlCommand | undefined {
  const name = requested.replace(/^\//, '');
  return commands.find((command) => command.name === name || command.aliases.includes(name));
}

/** The exact text a command turn carries. Arguments are the caller's; the shape is ours. */
export function commandText(command: ControlCommand, args: string | undefined): string {
  const trimmed = (args ?? '').trim();
  return trimmed.length === 0 ? `/${command.name}` : `/${command.name} ${trimmed}`;
}
