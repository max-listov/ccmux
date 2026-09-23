import type { z } from 'zod';
import type {
  TranscriptKindSchema,
  TranscriptMessageSchema,
  TranscriptRoleSchema,
} from './agent/transcript/messageSchema.ts';
import type {
  AgentKindSchema,
  ChatPrincipalSchema,
  ChatTargetSchema,
  CliPrincipalSchema,
  CodexAppPeerSchema,
  ExternalTargetSchema,
  ManagedPeerSchema,
  OwnerTargetSchema,
} from './chat/identitySchema.ts';
import type { ChatCursorsSchema, ChatMessageSchema } from './chat/messageSchema.ts';
import type {
  CodexCollaborationModeSchema,
  LaunchRecipeMetadataSchema,
  LaunchRecipeReferenceSchema,
  MachineLaunchRecipeSchema,
  PermissionModeSchema,
} from './config/launchSchema.ts';
import type {
  MachineConfigSchema,
  ReleaseSchema,
  TelegramConfigSchema,
} from './config/machineSchema.ts';
import type {
  TranscriptJsonSchema,
  TranscriptStatsSchema,
} from './context/transcriptJsonSchema.ts';
import type { SessionEventKindSchema, SessionEventSchema } from './events/schema.ts';
import type {
  ExternalCapabilitiesSchema,
  ExternalInventoryJsonSchema,
  ExternalSessionSchema,
  WriterRuntimeSchema,
} from './external/sessionSchema.ts';
import type {
  ContextInfoSchema,
  ListItemSchema,
  ListJsonSchema,
  ReleaseStandingSchema,
  SessionStateSchema,
} from './inventory/listSchema.ts';
import type {
  LifecycleBlockSchema,
  PendingSessionSchema,
  SessionSchema,
} from './session/schema.ts';

// The inferred types of the persisted and wire shapes defined in `src/config/*Schema.ts`, under
// the names the rest of the code uses. No bare interfaces for these shapes: each type is `z.infer` of
// its schema. A module that owns a schema of its own infers its type beside it.
export type Session = z.infer<typeof SessionSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type MachineConfig = z.infer<typeof MachineConfigSchema>;
export type Release = z.infer<typeof ReleaseSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
export type ContextInfo = z.infer<typeof ContextInfoSchema>;
export type ListItem = z.infer<typeof ListItemSchema>;
export type ListJson = z.infer<typeof ListJsonSchema>;
export type ReleaseStanding = z.infer<typeof ReleaseStandingSchema>;
export type TranscriptRole = z.infer<typeof TranscriptRoleSchema>;
export type TranscriptKind = z.infer<typeof TranscriptKindSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
export type TranscriptStats = z.infer<typeof TranscriptStatsSchema>;
export type TranscriptJson = z.infer<typeof TranscriptJsonSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type ManagedPeer = z.infer<typeof ManagedPeerSchema>;
export type CliPrincipal = z.infer<typeof CliPrincipalSchema>;
export type CodexAppPeer = z.infer<typeof CodexAppPeerSchema>;
export type ChatPrincipal = z.infer<typeof ChatPrincipalSchema>;
export type OwnerTarget = z.infer<typeof OwnerTargetSchema>;
export type ExternalTarget = z.infer<typeof ExternalTargetSchema>;
export type ChatTarget = z.infer<typeof ChatTargetSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCursors = z.infer<typeof ChatCursorsSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type PendingSession = z.infer<typeof PendingSessionSchema>;
export type LifecycleBlock = z.infer<typeof LifecycleBlockSchema>;
export type ExternalSession = z.infer<typeof ExternalSessionSchema>;
export type ExternalInventoryJson = z.infer<typeof ExternalInventoryJsonSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventKind = z.infer<typeof SessionEventKindSchema>;
export type ExternalCapabilities = z.infer<typeof ExternalCapabilitiesSchema>;
export type WriterRuntime = z.infer<typeof WriterRuntimeSchema>;
export type LaunchRecipeReference = z.infer<typeof LaunchRecipeReferenceSchema>;
export type LaunchRecipeMetadata = z.infer<typeof LaunchRecipeMetadataSchema>;
export type MachineLaunchRecipe = z.infer<typeof MachineLaunchRecipeSchema>;
export type CodexCollaborationMode = z.infer<typeof CodexCollaborationModeSchema>;
