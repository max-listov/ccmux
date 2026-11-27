import type { JsonRpcValue } from 'stitchkit/agent-executor';
import type {
  CodexNotificationEvent,
  CodexServerRequestEvent,
  CodexSession,
  CodexThreadPolicyOverrides,
} from 'stitchkit/agent-executor/codex';
import { z } from 'zod';
import { admitNativeFork, type NativeForkIntent } from '../../../context/fork.ts';
import { assertDelegatedCodexAcknowledgement } from '../../../delegation/codex.ts';
import { delegationRefused } from '../../../delegation/resolve.ts';
import { policySkillInputs } from '../../../policy/codex.ts';
import { verifyApplicationPolicy } from '../../../policy/resolve.ts';
import { readSelection } from '../../../runtime/selection.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { codexAppMessagePersisted } from '../appPickup.ts';
import {
  buildCodexExecutorTurnInput,
  type CodexAppThreadContext,
  CodexAppThreadContextSchema,
  type CodexAppTurnPolicy,
  prepareManagedCodexTurn,
} from '../appServer.ts';
import { codexProfile } from '../profileRoot.ts';
import { rolloutReadiness } from '../resume.ts';
import { type CodexTurnInput, codexTextInput } from '../turnInput.ts';
import { ownedCodexDeveloperInstructions } from './launch.ts';
import { ownedCodexSocket } from './paths.ts';
import {
  codexExecutorProfile,
  createCodexSocketDriver,
  OWNED_CODEX_MAX_FRAME_BYTES,
} from './rpc.ts';

const BOOTSTRAP_PROMPT =
  'Initialize this managed session. Reply READY briefly, without using tools or contacting other sessions.';

const NativeConfigReadSchema = z.object({
  config: z.looseObject({
    approval_policy: z.unknown().optional(),
    sandbox_mode: z.unknown().optional(),
    mcp_servers: z.record(z.string(), z.unknown()).optional(),
    plugins: z.record(z.string(), z.unknown()).optional(),
  }),
});

const SandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
const ApprovalPolicySchema = z.union([
  z.enum(['untrusted', 'on-failure', 'on-request', 'never']),
  z.record(z.string(), z.json()),
]);

export interface OpenOwnedThreadCallbacks {
  onNotification: (event: CodexNotificationEvent) => void;
  onServerRequest: (event: CodexServerRequestEvent) => void;
  onDisconnect: (error: Error) => void;
}

/**
 * Start, resume or fork the owned thread through `stitchkit/agent-executor/codex`.
 *
 * Policy enforcement (`prepareThread` + `verifyThread`) runs on the same connection before the
 * session handle is returned, and a fork goes through the durable admission ledger so a lost
 * acknowledgement never dispatches a duplicate conversation.
 */
export async function openOwnedThread(
  m: MachineConfig,
  initial: Session,
  fresh: boolean,
  fork: NativeForkIntent | null,
  callbacks: OpenOwnedThreadCallbacks,
  signal: AbortSignal,
): Promise<{ session: CodexSession; response: CodexAppThreadContext }> {
  const application =
    initial.applicationPolicy === undefined
      ? null
      : verifyApplicationPolicy(m, 'codex', initial.applicationPolicy);
  const currentSelection = readSelection(m, initial);
  const selectedModel = currentSelection?.options.model ?? initial.modelSelection;
  const developerInstructions = ownedCodexDeveloperInstructions(initial, m);

  const driver = createCodexSocketDriver(ownedCodexSocket(m, initial.name), {
    maxFrameBytes: OWNED_CODEX_MAX_FRAME_BYTES,
    developerInstructions,
    ...(selectedModel === undefined
      ? {}
      : { model: selectedModel.model, modelProvider: selectedModel.provider }),
    onNotification: callbacks.onNotification,
    onServerRequest: callbacks.onServerRequest,
    serverRequestDelivery: 'all',
    onDisconnect: callbacks.onDisconnect,
    prepareThread: async ({ controls, cwd }) => {
      if (application?.runtime === 'codex' && application.skills.length > 0) {
        policySkillInputs(
          application,
          initial.dir,
          await controls.listSkills({ cwds: [initial.dir], forceReload: true }),
        );
      }
      if (initial.delegation !== undefined) {
        const access = initial.delegation.policy.access;
        if (access === 'full-access') delegationRefused('Unconfined delegation is unsupported');
        const nativeConfig = NativeConfigReadSchema.parse(
          await controls.readConfig({ includeLayers: false, cwd }),
        );
        const disabledServers: Record<string, JsonRpcValue> = Object.fromEntries(
          Object.keys(nativeConfig.config.mcp_servers ?? {}).map((name) => [
            name,
            { enabled: false },
          ]),
        );
        const disabledPlugins: Record<string, JsonRpcValue> = Object.fromEntries(
          Object.keys(nativeConfig.config.plugins ?? {}).map((name) => [name, { enabled: false }]),
        );
        const overrides: CodexThreadPolicyOverrides = {
          approvalPolicy: 'never',
          sandbox: access,
          runtimeWorkspaceRoots: [initial.dir],
          config: {
            mcp_servers: disabledServers,
            plugins: disabledPlugins,
            'sandbox_workspace_write.writable_roots': [initial.dir],
            'sandbox_workspace_write.exclude_tmpdir_env_var': true,
            'sandbox_workspace_write.exclude_slash_tmp': true,
            'sandbox_workspace_write.network_access': false,
            'features.multi_agent': false,
            'features.connectors': false,
            'features.apps': false,
            'features.remote_plugin': false,
            'features.tool_suggest': false,
            web_search: 'disabled',
          },
        };
        return overrides;
      }
      // Preserve effective server/profile approval & sandbox defaults (e.g. `-c` flags or user
      // config.toml) instead of overwriting them with driver defaults.
      const read = await controls.readConfig({ includeLayers: false, cwd }).catch(() => null);
      const parsed = read === null ? null : NativeConfigReadSchema.safeParse(read);
      if (parsed === null || !parsed.success) return undefined;
      const approval = ApprovalPolicySchema.safeParse(parsed.data.config.approval_policy);
      const sandbox = SandboxModeSchema.safeParse(parsed.data.config.sandbox_mode);
      if (!approval.success && !sandbox.success) return undefined;
      return {
        ...(approval.success ? { approvalPolicy: approval.data } : {}),
        ...(sandbox.success ? { sandbox: sandbox.data } : {}),
      };
    },
    verifyThread: async ({ nativeThreadId, threadContext, controls }) => {
      if (!fresh && fork === null && nativeThreadId !== initial.uuid)
        throw new Error('Native resume returned a different thread identity');
      CodexAppThreadContextSchema.parse(threadContext);
      if (
        selectedModel !== undefined &&
        (threadContext.model !== selectedModel.model ||
          threadContext.modelProvider !== selectedModel.provider)
      )
        throw new Error('Native admission changed the selected provider or model');
      assertDelegatedCodexAcknowledgement(initial, threadContext);
      if (initial.delegation !== undefined) {
        const servers = z
          .object({
            data: z.array(
              z.object({
                runtimeStatus: z.literal('disabled'),
                tools: z.record(z.string(), z.unknown()),
                resources: z.array(z.unknown()),
                resourceTemplates: z.array(z.unknown()),
              }),
            ),
            nextCursor: z.string().nullable(),
          })
          .parse(
            await controls.listMcpServerStatus({
              limit: 100,
              threadId: nativeThreadId,
            }),
          );
        if (
          servers.nextCursor !== null ||
          servers.data.some(
            (server) =>
              Object.keys(server.tools).length ||
              server.resources.length ||
              server.resourceTemplates.length,
          )
        )
          delegationRefused('Delegated runtime cannot expose host MCP tools');
      }
    },
  });

  const profile = codexExecutorProfile(m, initial);
  const openSession = async (): Promise<CodexSession> => {
    if (fork === null) {
      return driver.open({
        profile,
        cwd: initial.dir,
        ...(fresh ? {} : { nativeThreadId: initial.uuid }),
        signal,
      });
    }
    return admitNativeFork(
      m,
      initial,
      {
        fork: async (source, nativeSignal) => {
          nativeSignal.throwIfAborted();
          return driver.open({
            profile,
            cwd: initial.dir,
            forkFrom: {
              threadId: source.nativeId,
              ...(source.turnId === null ? {} : { lastTurnId: source.turnId }),
              excludeTurns: true,
              deferGoalContinuation: true,
            },
            signal: nativeSignal,
          });
        },
        identity: (opened) => opened.nativeThreadId,
        resume: async (threadId, nativeSignal) => {
          nativeSignal.throwIfAborted();
          return driver.open({
            profile,
            cwd: initial.dir,
            nativeThreadId: threadId,
            signal: nativeSignal,
          });
        },
      },
      signal,
    );
  };

  const session = await openSession();
  const response = CodexAppThreadContextSchema.parse(session.threadContext);
  return { session, response };
}

/** Start a managed turn through a live Stitchkit `CodexSession`, enforcing `beforeStart` first. */
export async function startOwnedCodexTurn(
  session: Pick<CodexSession, 'startTurn'>,
  messageId: string,
  input: CodexTurnInput[],
  policy?: CodexAppTurnPolicy,
): Promise<string> {
  policy?.beforeStart?.();
  const turn = await session.startTurn(buildCodexExecutorTurnInput(messageId, input, policy));
  return turn.nativeTurnId;
}

/**
 * Give a new thread its first turn and wait until the provider has written it down.
 *
 * Admission is only honest once the rollout's metadata is readable: before that, a reader that
 * resolves the session by its rollout finds nothing, and a restart would not find the thread.
 */
export async function bootstrapOwnedThread(input: {
  executor: Pick<CodexSession, 'startTurn' | 'listSkills' | 'listCollaborationModes'>;
  m: MachineConfig;
  session: Session;
  /** The client message id of the bootstrap turn — immutable, so a retry is the same turn. */
  clientId: string;
  response: CodexAppThreadContext;
  signal: AbortSignal;
  /** Throws once the connection has failed or closed. */
  alive: () => void;
  /** The turn was accepted. */
  started: () => void;
}): Promise<void> {
  const { executor, m, session } = input;
  const policy = await prepareManagedCodexTurn(executor, m, session, input.response);
  const start = async () => {
    await startOwnedCodexTurn(executor, input.clientId, codexTextInput(BOOTSTRAP_PROMPT), policy);
    input.started();
  };
  const deadline = Date.now() + m.codexCorrelationTimeoutMs;
  let turnError: unknown = null;
  try {
    await start();
  } catch (error) {
    turnError = error;
  }
  let rollout = rolloutReadiness(session, m);
  while (rollout.status !== 'ready' && Date.now() < deadline) {
    input.signal.throwIfAborted();
    input.alive();
    await Bun.sleep(50);
    rollout = rolloutReadiness(session, m);
  }
  if (rollout.status !== 'ready')
    throw new Error(
      `Native session rollout metadata did not become readable before admission (${rollout.detail}; turn=${String(turnError)})`,
    );
  if (turnError === null) return;
  // A provider can expose the rollout inode before committing session_meta, then reject the first
  // turn while its own thread store is between those two states. Retry only that named pre-dispatch
  // failure, with the same immutable client id, and first rule out a persisted acceptance after a
  // lost response.
  if (!/thread-store.*(?:rollout is empty|session metadata)/i.test(String(turnError)))
    throw turnError;
  if (
    !(await codexAppMessagePersisted(
      m,
      session.uuid,
      input.clientId,
      codexProfile(session, m).sessionsDir,
    ))
  )
    await start();
}
