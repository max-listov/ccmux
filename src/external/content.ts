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
  type ExternalContentEntry,
  type ExternalContentReadSchema,
  type ExternalContentResult,
  ExternalContentResultSchema,
  type ExternalContentTarget,
  EXTERNAL_CONTENT_LIMITS as limits,
} from './contentSchema.ts';
import {
  locateExternalStorage,
  readExternalCodexMetadata,
  validateExternalPath,
} from './storage.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const CursorSchema = z
  .object({ identity: z.string(), revision: z.string(), end: z.number().int().nonnegative() })
  .strict();
const TextSchema = z.object({
  type: z.enum(['text', 'input_text', 'output_text']),
  text: z.string(),
});
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.unknown())]),
});
const CodexMessageSchema = MessageSchema.extend({ type: z.literal('message') });
const RecordSchema = z.object({
  type: z.string().optional(),
  sessionId: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  payload: z.unknown().optional(),
  message: z.unknown().optional(),
});

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

function stamp(
  stat: Awaited<ReturnType<typeof lstat>>,
  root: string,
  target: ExternalContentTarget,
) {
  return digest(
    JSON.stringify([target, root, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]),
  );
}

function project(
  raw: string,
  target: ExternalContentTarget,
  offset: number,
): ExternalContentEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RecordSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.isMeta || record.isCompactSummary) return null;
  if (target.provider === 'claude' && record.sessionId !== target.threadId) return null;
  if (target.provider === 'codex' && record.type !== 'response_item') return null;
  const message =
    target.provider === 'codex'
      ? CodexMessageSchema.safeParse(record.payload)
      : MessageSchema.safeParse(record.message);
  if (!message.success) return null;
  const text =
    typeof message.data.content === 'string'
      ? message.data.content
      : message.data.content
          .flatMap((part) => {
            const item = TextSchema.safeParse(part);
            return item.success ? [item.data.text] : [];
          })
          .join('\n');
  if (!text) return null;
  return {
    id: String(offset),
    role: message.data.role,
    text: text.slice(0, limits.textCharacters),
    truncated: text.length > limits.textCharacters,
  };
}

/** One bounded persisted view. Reading never contacts, starts or takes ownership of a writer. */
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
  const identity = digest(JSON.stringify(input.target));
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
    if (!configuredRoot) return result;
    const root = await realpath(configuredRoot);
    const path = await locateExternalStorage(root, input.target, signal);
    if (path === null) return { ...result, outcome: cursor ? 'stale' : 'history-absent' };
    await validateExternalPath(root, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new AppError('PERMISSION_DENIED', 'External storage is not accessible', 403);
      const revision = stamp(stat, root, input.target);
      if (stamp(await lstat(path), root, input.target) !== revision)
        throw new Error('Storage replaced');
      if (cursor && (cursor.revision !== revision || cursor.end > stat.size))
        return { ...result, outcome: 'stale', revision };
      if (input.target.provider === 'codex')
        await readExternalCodexMetadata(file, input.target.threadId);
      const end = cursor?.end ?? stat.size;
      const start = Math.max(0, end - limits.sourceBytes);
      const bytes = Buffer.alloc(end - start);
      let read = 0;
      while (read < bytes.length) {
        signal.throwIfAborted();
        const part = await file.read(bytes, read, bytes.length - read, start + read);
        if (part.bytesRead === 0) break;
        read += part.bytesRead;
      }
      if (read !== bytes.length) return { ...result, outcome: 'stale', revision };
      const first = start === 0 ? 0 : bytes.indexOf(10) + 1;
      let position = first;
      const rows: { offset: number; value: ExternalContentEntry }[] = [];
      let omitted = start > 0 ? 1 : 0;
      while (position < bytes.length) {
        signal.throwIfAborted();
        const newline = bytes.indexOf(10, position);
        if (newline < 0) {
          omitted++;
          break;
        }
        const row = project(
          bytes.toString('utf8', position, newline),
          input.target,
          start + position,
        );
        if (row) rows.push({ offset: start + position, value: row });
        else omitted++;
        position = newline + 1;
      }
      const selected = rows.slice(-input.limit);
      const boundary = start + first < end ? start + first : start;
      const nextEnd = rows.length > selected.length ? (selected[0]?.offset ?? boundary) : boundary;
      await validateExternalPath(root, path);
      authorize(m, input.target);
      if (
        stamp(await file.stat(), root, input.target) !== revision ||
        stamp(await lstat(path), root, input.target) !== revision
      )
        return { ...result, outcome: 'stale', revision };
      return ExternalContentResultSchema.parse({
        ...result,
        outcome: 'available',
        revision,
        entries: selected.map((row) => row.value),
        nextCursor:
          nextEnd > 0
            ? Buffer.from(JSON.stringify({ identity, revision, end: nextEnd })).toString(
                'base64url',
              )
            : null,
        truncated: nextEnd > 0 || omitted > 0 || selected.some((row) => row.value.truncated),
        omittedRecords: omitted,
      });
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
