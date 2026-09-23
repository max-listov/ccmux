import { z } from 'zod';
import { TranscriptMessageSchema } from '../agent/transcript/messageSchema.ts';
import { AgentKindSchema, RC_PREFIX_RE } from '../chat/identitySchema.ts';
import { ExternalTurnStateSchema } from './turnSchema.ts';

/*
 * Threads that exist outside the registry, as observed evidence. Every persisted or remote shape
 * has one schema; its type is `z.infer` of it.
 */

// Provider-neutral inventory row for a conversation that exists outside ccmux's registry.
// Discovery reports evidence and capabilities separately: a stored rollout is not proof that a
// writer is live, and a writer lock is not proof that a transcript has been persisted yet.
export const ExternalOriginSchema = z.enum([
  'cli',
  'desktop',
  'vscode',
  'exec',
  'app-server',
  'subagent',
  'unknown',
]);
export const ExternalStorageSchema = z.enum(['stored', 'missing', 'unknown']);
export const WriterEvidenceSchema = z.enum(['observed', 'none-observed', 'unknown']);
export const WriterRuntimeKindSchema = z.enum([
  'managed',
  'dedicated-cli',
  'desktop',
  'vscode',
  'app-server',
  'shared',
  'self',
  'unknown',
]);

export const WriterRuntimeSchema = z
  .object({
    kind: WriterRuntimeKindSchema,
    pid: z.number().int().positive().nullable(),
    startTime: z.string().nullable(),
    processGroup: z.number().int().positive().nullable(),
    reason: z.string().min(1),
  })
  .strict();

export const ExternalCapabilitiesSchema = z
  .object({
    inspect: z.boolean(),
    attemptAdopt: z.boolean(),
    fork: z.boolean(),
    terminateAndAdopt: z.boolean(),
    releaseAtSource: z.boolean(),
    reasons: z.array(z.string().min(1)),
  })
  .strict();

export const ExternalSessionSchema = z
  .object({
    key: z.string().min(1),
    plane: z.literal('external'),
    provider: AgentKindSchema,
    host: z.string().regex(RC_PREFIX_RE),
    threadId: z.uuid(),
    dir: z.string().startsWith('/').nullable(),
    path: z.string().startsWith('/').nullable(),
    origin: ExternalOriginSchema,
    storage: ExternalStorageSchema,
    writerEvidence: WriterEvidenceSchema,
    writerRuntime: WriterRuntimeSchema.nullable(),
    turnState: ExternalTurnStateSchema,
    capabilities: ExternalCapabilitiesSchema,
    lastActivityMs: z.number().nonnegative().nullable(),
    lastModel: z.string().nullable(),
    usedTokens: z.number().nonnegative().nullable(),
    lastMessage: TranscriptMessageSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.storage === 'stored' && value.path === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'stored external session requires transcript path',
      });
    }
    if (value.storage === 'missing' && (value.path !== null || value.dir !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage'],
        message: 'missing storage cannot claim transcript path or cwd',
      });
    }
  });

export const ExternalInventoryJsonSchema = z
  .object({
    version: z.string().min(1),
    generatedAt: z.iso.datetime(),
    rcPrefix: z.string().regex(RC_PREFIX_RE),
    sessions: z.array(ExternalSessionSchema),
  })
  .strict();
