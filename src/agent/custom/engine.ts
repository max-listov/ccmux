import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentHistoryProjectionOptions,
  type AgentLanguageModelProvider,
  type AgentRuntimeEvent,
  createAgentObservability,
  defineAgentProtocol,
  defineModelRegistry,
} from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import {
  type AgentHarnessProfileEvent,
  createHeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';
import { openRouterProvider } from 'stitchkit/agent-runtime/openrouter';
import { createBunSqliteAgentRuntimeStore } from 'stitchkit/agent-runtime/sqlite/bun';
import { mountAgent } from 'stitchkit/tools';
import { z } from 'zod';
import type { Session } from '../../types.ts';
import { privateRuntimeDirectory } from '../codex/ownedPaths.ts';
import { customArtifactStore } from './artifacts.ts';
import type { PreparedCustomHost } from './host.ts';
import { CustomInputMetadataSchema } from './input.ts';
import { prepareCustomResources } from './resources.ts';

/** The supervisor holds its existing owner lock before entering here. This is composition of the
 * public engine/store, not a second execution coordinator or a second conversation ledger. */
export async function openCustomEngine(input: {
  root: string;
  session: Session;
  host: PreparedCustomHost;
  publish(event: AgentRuntimeEvent): void | Promise<void>;
  onError(error: unknown): void | Promise<void>;
  diagnose?(error: unknown): void | Promise<void>;
  onProfile?(event: AgentHarnessProfileEvent): void | Promise<void>;
  resolveFile?: AgentHistoryProjectionOptions['resolveFile'];
  commandIdentity?: Readonly<Record<string, string>>;
  provider?: AgentLanguageModelProvider;
}) {
  const { root, session, host } = input;
  const registration = session.registrationGeneration;
  const conversationId = session.nativeSession?.id;
  if (
    !registration ||
    session.nativeSession?.runtime !== 'custom' ||
    !conversationId ||
    !session.launchRecipe
  )
    throw new Error('Custom managed identity is incomplete');
  privateRuntimeDirectory(root);
  const filename = join(root, 'conversation.sqlite');
  const file = await open(
    filename,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error('Custom canonical store must be a private regular file');
  } finally {
    await file.close();
  }
  const resources = await prepareCustomResources(join(root, 'resources'), host);
  const models = defineModelRegistry({
    models: Object.fromEntries(
      host.config.models.map((model) => [
        model.selection.model,
        {
          provider: model.selection.provider,
          modelId: model.selection.model,
          contextWindow: model.contextWindow,
          capabilities: model.capabilities,
        },
      ]),
    ),
    providers: { openrouter: input.provider ?? openRouterProvider({ apiKey: host.credential }) },
  });
  models.preflight(session.modelSelection?.model ?? host.config.defaultModel.model);
  const artifacts = customArtifactStore(join(root, 'outputs'));
  const coding = createAgentCodingTools({
    root: session.dir,
    authorize: () => true,
    executables: host.config.executables,
    environment: { ...host.commandEnvironment, ...input.commandIdentity },
    artifacts,
    limits: {
      maxArtifactBytes: 1024 * 1024,
      maxShellOutputBytes: 32 * 1024,
      maxReadBytes: 64 * 1024,
    },
  });
  const tools = [...coding, ...resources.runtimeTools].filter((tool) =>
    host.config.tools.some((name) => name === tool.name),
  );
  if (tools.length !== new Set(host.config.tools).size)
    throw new Error('Custom tool composition is incomplete');
  const context = z.object({ registration: z.literal(registration) }).strict();
  const sqlite = createBunSqliteAgentRuntimeStore({ filename });
  const observe = createAgentObservability({
    maxPending: 64,
    includeInternalCause: true,
    filter: (event) =>
      event.type === 'run-terminal' &&
      event.state === 'failed' &&
      event.internalCause !== undefined,
    write: (event) =>
      event.type === 'run-terminal'
        ? (input.diagnose ?? input.onError)(event.internalCause)
        : undefined,
    onSinkError: ({ error }) => input.onError(error),
    onDrop: () => input.onError(new Error('Custom private diagnostic sink refused an event')),
  });
  try {
    const harness = createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context,
        inputMetadata: CustomInputMetadataSchema,
        terminalAcceptance: 'require-output',
      }),
      store: sqlite.store,
      observe,
      models: {
        resolve: ({ run, snapshot }) => {
          if (run.conversationId !== conversationId || run.inputMessageIds.length !== 1)
            throw new Error('Custom run identity or input cardinality differs');
          const accepted = snapshot.messages.find(
            (message) => message.id === run.inputMessageIds[0],
          );
          const metadata = CustomInputMetadataSchema.parse(accepted?.metadata);
          if (
            metadata.registration !== registration ||
            metadata.recipeDigest !== session.launchRecipe?.digest ||
            metadata.model.provider !== host.config.provider.kind
          )
            throw new Error('Custom accepted execution authority differs');
          return models.resolve(metadata.model.model);
        },
      },
      resources: { load: () => resources.load() },
      tools: (run) => mountAgent([], { runtimeTools: tools, lifecycle: run.toolFenceLifecycle }),
      promptBudget: ({ contextWindow }) => ({
        contextWindow,
        reservedOutput: Math.min(4096, Math.floor(contextWindow / 4)),
        toolSchemas: {
          value: Math.ceil(
            Buffer.byteLength(JSON.stringify(tools.map((tool) => z.toJSONSchema(tool.input)))) / 3,
          ),
          provenance: 'estimated',
        },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { provenance: 'unavailable' },
      }),
      runs: { inputPolicy: 'queue', coalescePending: false },
      loop: {
        maxSteps: 32,
        idleTimeoutMs: 60_000,
        toolApprovalSecret: host.approvalSecret,
        toolApproval: Object.fromEntries(
          host.config.approvalTools.map((name): [string, 'user-approval'] => [
            name,
            'user-approval',
          ]),
        ),
      },
      publish: input.publish,
      history: {
        unresolvedFile: 'error',
        ...(input.resolveFile ? { resolveFile: input.resolveFile } : {}),
      },
      ...(input.onProfile ? { onProfile: input.onProfile } : {}),
      onProfileError: ({ error }) => input.onError(error),
      onPublishError: ({ error }) => input.onError(error),
    });
    return {
      conversationId,
      harness,
      sqlite,
      models,
      context: { registration },
      async close() {
        const result = await harness.close({ forceTimeoutMs: 5000 });
        if (!result.settled) throw new Error('Custom engine shutdown did not settle');
        await observe.close();
        await sqlite.close();
      },
    };
  } catch (error) {
    await observe.close();
    await sqlite.close();
    throw error;
  }
}
