import type { z } from "zod";
import type {
  SessionSchema,
  PermissionModeSchema,
  MachineConfigSchema,
  ReleaseSchema,
  SessionStateSchema,
  ContextInfoSchema,
  ListItemSchema,
  ListJsonSchema,
  TranscriptRoleSchema,
  TranscriptKindSchema,
  TranscriptMessageSchema,
  TranscriptStatsSchema,
  TranscriptJsonSchema,
  AgentKindSchema,
  ManagedPeerSchema,
  CliPrincipalSchema,
  ChatPrincipalSchema,
  OwnerTargetSchema,
  ChatTargetSchema,
  ChatMessageSchema,
  ChatCursorsSchema,
  TelegramConfigSchema,
  PendingSessionSchema,
  LifecycleBlockSchema,
  ExternalSessionSchema,
  SessionEventSchema,
  SessionEventKindSchema,
  ExternalCapabilitiesSchema,
  WriterRuntimeSchema,
} from "./config/schema.ts";

// Single import surface for the inferred types. No bare interfaces anywhere — these
// are the only shapes, and they come straight from the Zod schemas.
export type Session = z.infer<typeof SessionSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type MachineConfig = z.infer<typeof MachineConfigSchema>;
export type Release = z.infer<typeof ReleaseSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type ContextInfo = z.infer<typeof ContextInfoSchema>;
export type ListItem = z.infer<typeof ListItemSchema>;
export type ListJson = z.infer<typeof ListJsonSchema>;
export type TranscriptRole = z.infer<typeof TranscriptRoleSchema>;
export type TranscriptKind = z.infer<typeof TranscriptKindSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
export type TranscriptStats = z.infer<typeof TranscriptStatsSchema>;
export type TranscriptJson = z.infer<typeof TranscriptJsonSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type ManagedPeer = z.infer<typeof ManagedPeerSchema>;
export type CliPrincipal = z.infer<typeof CliPrincipalSchema>;
export type ChatPrincipal = z.infer<typeof ChatPrincipalSchema>;
export type OwnerTarget = z.infer<typeof OwnerTargetSchema>;
export type ChatTarget = z.infer<typeof ChatTargetSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCursors = z.infer<typeof ChatCursorsSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type PendingSession = z.infer<typeof PendingSessionSchema>;
export type LifecycleBlock = z.infer<typeof LifecycleBlockSchema>;
export type ExternalSession = z.infer<typeof ExternalSessionSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventKind = z.infer<typeof SessionEventKindSchema>;
export type ExternalCapabilities = z.infer<typeof ExternalCapabilitiesSchema>;
export type WriterRuntime = z.infer<typeof WriterRuntimeSchema>;
