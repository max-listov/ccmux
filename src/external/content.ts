import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import { loadSessions } from '../config/sessions.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import {
  ExternalContentCapabilitiesSchema,
  type ExternalContentReadSchema,
  type ExternalContentResult,
  ExternalContentResultSchema,
  type ExternalContentTarget,
  EXTERNAL_CONTENT_LIMITS as limits,
} from './contentSchema.ts';
import {
  buildContentSnapshot,
  fileIdentity,
  findContentSnapshot,
  getContentSnapshot,
  publishContentSnapshot,
  validateContentSnapshot,
} from './contentSnapshot.ts';
import {
  locateExternalStorage,
  readExternalCodexMetadata,
  validateExternalPath,
} from './storage.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const CursorSchema = z
  .object({ identity: z.string(), snapshot: z.uuid(), end: z.number().int().nonnegative() })
  .strict();

function authorize(m: MachineConfig, target: ExternalContentTarget) {
  if (target.machine !== m.rcPrefix)
    throw new AppError('IDENTITY_MISMATCH', 'External identity does not belong to this host', 409);
  if (!m.externalInventory)
    throw new AppError('PERMISSION_DENIED', 'External content access is disabled', 403);
  if (loadSessions(m).some((s) => s.agent === target.provider && s.uuid === target.threadId))
    throw new AppError(
      'IDENTITY_MISMATCH',
      'Use the managed history contract for this identity',
      409,
    );
}

/** Read an immutable authored-text snapshot; never contact or start a provider writer. */
export async function readExternalContent(
  m: MachineConfig,
  input: z.output<typeof ExternalContentReadSchema>,
  signal: AbortSignal,
): Promise<ExternalContentResult> {
  authorize(m, input.target);
  signal.throwIfAborted();
  const result: ExternalContentResult = {
    target: input.target,
    outcome: 'history-absent',
    revision: null,
    observedAt: new Date().toISOString(),
    entries: [],
    nextCursor: null,
    truncated: false,
    omittedRecords: 0,
  };
  const identity = digest(JSON.stringify([m.stateDir, input.target]));
  let cursor: z.output<typeof CursorSchema> | null = null;
  if (input.cursor !== null) {
    try {
      cursor = CursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new AppError('INVALID_CURSOR', 'External history cursor is invalid', 400);
    }
    if (cursor.identity !== identity)
      throw new AppError('IDENTITY_MISMATCH', 'External cursor identity differs', 409);
  }
  try {
    const configuredRoot = input.target.provider === 'codex' ? m.codexSessionsDir : m.projectsDir;
    if (!configuredRoot) return { ...result, outcome: cursor ? 'stale' : 'history-absent' };
    const root = await realpath(configuredRoot);
    const path = await locateExternalStorage(root, input.target, signal);
    if (path === null) return { ...result, outcome: cursor ? 'stale' : 'history-absent' };
    await validateExternalPath(root, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new AppError('PERMISSION_DENIED', 'External storage is not accessible', 403);
      if (fileIdentity(await lstat(path), path) !== fileIdentity(stat, path))
        return { ...result, outcome: 'stale' };
      if (input.target.provider === 'codex')
        await readExternalCodexMetadata(file, input.target.threadId);
      const snapshot = cursor
        ? getContentSnapshot(cursor.snapshot)
        : (findContentSnapshot(identity, stat, path) ??
          (await buildContentSnapshot(file, stat, path, identity, input.target, signal)));
      if (
        !snapshot ||
        snapshot.identity !== identity ||
        (cursor && cursor.end > snapshot.entries.length)
      )
        return { ...result, outcome: 'stale' };
      if (!(await validateContentSnapshot(snapshot, file, path, signal)))
        return { ...result, outcome: 'stale' };
      await validateExternalPath(root, path);
      authorize(m, input.target);
      if (fileIdentity(await lstat(path), path) !== snapshot.fileIdentity)
        return { ...result, outcome: 'stale' };
      const end = cursor?.end ?? snapshot.entries.length;
      let start = end;
      let entryBytes = 0;
      while (start > 0 && end - start < input.limit) {
        const entry = snapshot.entries[start - 1];
        if (!entry) break;
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (entryBytes + bytes > limits.responseBytes - 8192) break;
        entryBytes += bytes;
        start--;
      }
      const entries = snapshot.entries.slice(start, end);
      const page = ExternalContentResultSchema.parse({
        ...result,
        outcome: 'available',
        revision: snapshot.revision,
        entries,
        nextCursor:
          start > 0
            ? Buffer.from(JSON.stringify({ identity, snapshot: snapshot.id, end: start })).toString(
                'base64url',
              )
            : null,
        truncated: start > 0 || snapshot.omitted > 0 || entries.some((row) => row.truncated),
        omittedRecords: snapshot.omitted,
      });
      if (Buffer.byteLength(JSON.stringify(page)) > limits.responseBytes)
        throw new AppError(
          'RESOURCE_EXHAUSTED',
          'External history response exceeds its byte budget',
          413,
        );
      if (!cursor) publishContentSnapshot(snapshot);
      return page;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (signal.aborted || error instanceof AppError) throw error;
    log.warn({ msg: 'external content read unavailable', reason: String(error) });
    return { ...result, outcome: 'unavailable' };
  }
}

export async function readExternalContentCapabilities(
  m: MachineConfig,
  target: ExternalContentTarget,
  signal: AbortSignal,
) {
  const page = await readExternalContent(m, { target, cursor: null, limit: 1 }, signal);
  const unsupported = { supported: false, reason: 'not-exposed' } satisfies {
    supported: false;
    reason: 'not-exposed';
  };
  return ExternalContentCapabilitiesSchema.parse({
    target,
    history: {
      outcome: page.outcome,
      source: 'provider-storage',
      projection: 'authored-text',
      pageEntries: limits.entries,
      sourceBytes: limits.sourceBytes,
    },
    control: {
      message: unsupported,
      interrupt: unsupported,
      respond: unsupported,
      fork: unsupported,
      compact: unsupported,
    },
  });
}
