import type { z } from "zod";
import type {
  SessionSchema,
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
} from "./config/schema.ts";

// Single import surface for the inferred types. No bare interfaces anywhere — these
// are the only shapes, and they come straight from the Zod schemas.
export type Session = z.infer<typeof SessionSchema>;
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
