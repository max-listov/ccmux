import { z } from 'zod';
import { AgentKindSchema } from '../config/schema.ts';
import type { Session } from '../types.ts';
import { hasNativeRuntime } from './modes.ts';

export const RuntimeCapabilitiesSchema = z
  .object({
    runtime: AgentKindSchema,
    structured: z.boolean(),
    modelCatalog: z.boolean(),
    modelSelection: z.boolean(),
    approval: z.boolean(),
    input: z.boolean(),
    nativeStream: z.boolean(),
    interrupt: z.boolean(),
    resume: z.boolean(),
    imageInput: z.boolean(),
    selectionDefaults: z.boolean(),
    turnOptions: z.boolean(),
    turnSteering: z.boolean(),
    history: z.boolean(),
    fork: z.boolean(),
    compaction: z.boolean(),
    rollback: z.boolean(),
    applicationPolicy: z.boolean(),
    /** The runtime names its own slash commands, and one can be run as a turn. */
    commandCatalog: z.boolean(),
    /** The permission mode a turn runs under can be read and changed while the session lives. */
    permissionModes: z.boolean(),
    /** The runtime can record the files a turn modifies and put them back on request. */
    fileCheckpoints: z.boolean(),
    /** The session's MCP servers can be read, and one can be enabled, disabled or reconnected. */
    mcpControl: z.boolean(),
  })
  .strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export const RuntimeCatalogInputSchema = z.object({}).strict();
export const RuntimeCatalogSchema = z
  .object({
    runtimes: z
      .array(
        z
          .object({
            // The agent family. It is not a unique key: an agent with more than one execution mode
            // contributes one row per mode, and `mode` is what separates them.
            runtime: AgentKindSchema,
            /** The execution mode this row describes, because availability differs per mode. */
            mode: z.enum(['tui', 'app-server', 'native']),
            availability: z.enum(['configured', 'unavailable']),
            reason: z.string().nullable(),
            capabilities: RuntimeCapabilitiesSchema,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

const unsupportedNativeOperations = {
  commandCatalog: false,
  permissionModes: false,
  fileCheckpoints: false,
  mcpControl: false,
  imageInput: false,
  selectionDefaults: false,
  turnOptions: false,
  turnSteering: false,
  history: false,
  fork: false,
  compaction: false,
  rollback: false,
  applicationPolicy: false,
};
const nativeOperations = {
  ...unsupportedNativeOperations,
  imageInput: true,
  selectionDefaults: true,
  turnOptions: true,
  history: true,
  fork: true,
  compaction: true,
  applicationPolicy: true,
};
const capabilities = {
  /**
   * Declared for the NATIVE mode; the degrade mask below produces the interactive row from it.
   *
   * Reading this record directly would misdescribe an interactive session, which is the common case
   * — only `runtimeCapabilities()` is honest, because it applies the mask when the session has no
   * native runtime. Rollback stays off: the runtime will not un-say a conversation, and a capability
   * advertised without an implementation behind it is a promise the control plane breaks on the
   * first call.
   */
  claude: {
    runtime: 'claude',
    structured: true,
    modelCatalog: true,
    modelSelection: true,
    approval: true,
    input: true,
    nativeStream: true,
    interrupt: true,
    resume: true,
    ...unsupportedNativeOperations,
    selectionDefaults: true,
    turnOptions: true,
    imageInput: true,
    commandCatalog: true,
    permissionModes: true,
    fileCheckpoints: true,
    mcpControl: true,
    history: true,
    fork: true,
    compaction: true,
  },
  codex: {
    runtime: 'codex',
    structured: true,
    modelCatalog: true,
    modelSelection: true,
    approval: true,
    input: true,
    nativeStream: true,
    interrupt: true,
    resume: true,
    ...nativeOperations,
    turnSteering: true,
  },
  opencode: {
    runtime: 'opencode',
    structured: true,
    modelCatalog: true,
    modelSelection: true,
    approval: true,
    input: true,
    nativeStream: true,
    interrupt: true,
    resume: true,
    ...nativeOperations,
  },
  custom: {
    runtime: 'custom',
    structured: true,
    modelCatalog: true,
    modelSelection: true,
    approval: true,
    input: false,
    nativeStream: true,
    interrupt: true,
    resume: true,
    ...unsupportedNativeOperations,
    selectionDefaults: true,
    turnOptions: true,
    history: true,
    imageInput: true,
  },
} satisfies Record<Session['agent'], RuntimeCapabilities>;

export function runtimeCapabilities(
  session: Pick<Session, 'agent' | 'runtime'>,
): RuntimeCapabilities {
  const declared = capabilities[session.agent];
  if (!hasNativeRuntime(session))
    return {
      ...declared,
      structured: false,
      modelCatalog: false,
      modelSelection: false,
      approval: false,
      input: false,
      nativeStream: false,
      interrupt: false,
      ...unsupportedNativeOperations,
    };
  return { ...declared };
}
