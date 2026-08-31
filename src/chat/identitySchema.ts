import { z } from 'zod';

/** Session selectors exclude whitespace and delimiters used by exact routing. */
export const SESSION_NAME_RE = /^[^|\s#:]+$/;
/** Machine identity is an extensible lowercase slug, not a fixed fleet enum. */
export const RC_PREFIX_RE = /^[a-z][a-z0-9-]*$/;
/** Execution runtime is independent of the selected model provider. */
export const AgentKindSchema = z.enum(['claude', 'codex', 'opencode', 'custom']);

export const ManagedPeerSchema = z
  .object({
    kind: z.literal('managed'),
    source: z.literal('ccmux'),
    machine: z.string().regex(RC_PREFIX_RE),
    agent: AgentKindSchema,
    session: z.string().min(1).regex(SESSION_NAME_RE),
    threadId: z.uuid(),
  })
  .strict();
export const CliPrincipalSchema = z
  .object({
    kind: z.literal('cli'),
    source: z.literal('ccmux'),
    machine: z.string().regex(RC_PREFIX_RE),
  })
  .strict();
export const ServicePrincipalSchema = z
  .object({
    kind: z.literal('service'),
    source: z.literal('ccmux'),
    machine: z.string().regex(RC_PREFIX_RE),
    transport: z.enum(['local', 'declared-service']),
  })
  .strict();
export const CodexAppPeerSchema = z
  .object({
    kind: z.literal('codex-app'),
    source: z.literal('codex-app'),
    machine: z.string().regex(RC_PREFIX_RE),
    agent: z.literal('codex'),
    threadId: z.uuid(),
    name: z.string().min(1).max(240).nullable(),
  })
  .strict();
/** Sender identifies ingress; it does not authenticate an attributed human. */
export const ChatPrincipalSchema = z.union([
  ManagedPeerSchema,
  CodexAppPeerSchema,
  CliPrincipalSchema,
  ServicePrincipalSchema,
]);
/** Out-of-band destinations never masquerade as managed sessions. */
export const OwnerTargetSchema = z.object({ kind: z.literal('owner') }).strict();
export const ExternalTargetSchema = z
  .object({
    kind: z.literal('external'),
    source: z.literal('ccmux'),
    name: z.string().min(1).regex(SESSION_NAME_RE),
  })
  .strict();
export const ChatTargetSchema = z.union([
  ManagedPeerSchema,
  CodexAppPeerSchema,
  OwnerTargetSchema,
  ExternalTargetSchema,
]);

export type ChatPrincipal = z.infer<typeof ChatPrincipalSchema>;
export type ChatTarget = z.infer<typeof ChatTargetSchema>;
