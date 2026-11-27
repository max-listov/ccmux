import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentEngineTurn } from 'stitchkit/agent-executor';
import {
  type ClaudeSdkDriver,
  type ClaudeSdkPermissionRequestMeta,
  type ClaudeSdkSession,
  type ClaudeSdkTurnUsage,
  createClaudeSdkDriver,
} from 'stitchkit/agent-executor/claude-sdk';
import type { AgentMessagePart } from 'stitchkit/agent-runtime';
import { ContentProducer } from '../../../content/producer.ts';
import { claudeContextApi } from '../../../context/claude.ts';
import { readNativeForkIntent } from '../../../context/fork.ts';
import { applyContextCommands, NativeContextPump } from '../../../context/pump.ts';
import { contextMutationPending } from '../../../context/store.ts';
import { recordDelegationApplied } from '../../../delegation/evidence.ts';
import { tryNativeAdmission } from '../../../runtime/admission.ts';
import { assertInferenceFreeCreate } from '../../../runtime/creation.ts';
import { readRuntimeInput } from '../../../runtime/input.ts';
import { registerRuntimeOwnership } from '../../../runtime/ownership.ts';
import { planLimitsDue } from '../../../runtime/planLimits.ts';
import { ManagedRuntimeStatusWriter } from '../../../runtime/status.ts';
import { nativeContextWake } from '../../../runtime/wake.ts';
import { sleepBlocksStart } from '../../../session/sleep/store.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { recordClaudeSdkUsage } from '../../../usage/claudeSdk.ts';
import { log } from '../../../util/log.ts';
import { grantIdentity } from '../../launch/identityEnv.ts';
import { launchEnv } from '../launch.ts';
import {
  type Discovery,
  loadAccount,
  loadCatalog,
  loadCommands,
  refreshContextUsage,
  refreshMcpServers,
  refreshPlanLimits,
} from './discovery.ts';
import { claudeExecutorProfile, claudeSdkDriverConfig, loadAgentSdk } from './driver.ts';
import { adoptNativeFork } from './fork.ts';
import {
  applyInterrupt,
  applyMcpRequest,
  applyMode,
  applyResponse,
  applyRewind,
  type Mailboxes,
  restoreMode,
} from './mailboxes.ts';
import { approvalRequest, type PendingApproval } from './permission.ts';
import { TurnPickup } from './pickup.ts';
import { NativeProjection } from './projection.ts';
import { advanceTurn } from './turn.ts';

/** How often the sample is CHECKED, not how often it is read: `planLimitsDue` decides the read. */
const PLAN_LIMITS_TICK_MS = 15_000;

/**
 * The single-writer owner for one native Claude conversation, driven through
 * `stitchkit/agent-executor/claude-sdk`.
 */
export class ClaudeNativeOwner {
  private writer: ManagedRuntimeStatusWriter;
  private driver: ClaudeSdkDriver | null = null;
  private sdkSession: ClaudeSdkSession | null = null;
  private activeTurn: AgentEngineTurn | null = null;
  private pickup = new TurnPickup();
  private failure: unknown = null;
  private pending = new Map<string, PendingApproval>();
  private resolvedFiles = new Map<string, Uint8Array>();
  private projection = new NativeProjection();
  private providerPid = process.pid;
  private providerDiagnostic = '';
  private usageEpoch = crypto.randomUUID();
  private pendingInput = true;
  private sessionAbort = new AbortController();
  private contextAbort = new AbortController();
  private contextPump: NativeContextPump = new NativeContextPump((error) => {
    void this.report(error);
  });

  private get mailboxes(): Mailboxes {
    return {
      m: this.m,
      session: this.session,
      sdkSession: this.sdkSession,
      activeTurn: () => this.activeTurn,
      projection: this.projection,
      discovery: this.discovery,
      pending: this.pending,
      publish: () => this.publish(),
      report: this.report,
    };
  }

  private get discovery(): Discovery {
    return {
      m: this.m,
      session: this.session,
      sdkSession: this.sdkSession,
      projection: this.projection,
      report: this.report,
    };
  }

  constructor(
    private m: MachineConfig,
    private session: Session,
    private report: (error: unknown) => Promise<void>,
  ) {
    this.writer = new ManagedRuntimeStatusWriter(m, session);
  }

  /** The session as this owner resolved it — a fork changes the conversation it points at. */
  get identity(): Session {
    return this.session;
  }

  /** Whatever ended the runtime, so the supervising loop can stop rather than publish a corpse. */
  get failed(): unknown {
    return this.failure;
  }

  async open(): Promise<void> {
    assertInferenceFreeCreate(this.session);
    const generation = this.session.registrationGeneration;
    if (!generation || !this.session.nativeSession)
      throw new Error('Native Claude requires a managed registration');
    this.projection.content = new ContentProducer(this.m, this.session, generation);
    const env = launchEnv(this.m, this.session);
    const sdk = await loadAgentSdk(this.m);
    if (readNativeForkIntent(this.m, this.session) !== null) {
      this.session = await adoptNativeFork(this.m, this.session, sdk);
    }
    grantIdentity(env, this.m, this.session);
    const profile = claudeExecutorProfile(this.m, this.session, env);
    this.usageEpoch = crypto.randomUUID();

    this.driver = createClaudeSdkDriver(
      claudeSdkDriverConfig({
        m: this.m,
        session: this.session,
        sdk,
        onProviderPid: (pid) => {
          this.providerPid = pid;
        },
        stderr: (chunk) => {
          this.providerDiagnostic = (this.providerDiagnostic + chunk).slice(-8192);
        },
        onQueryExit: (error) => {
          this.handleQueryExit(error);
        },
        onPermissionRequest: (meta) => {
          this.handlePermissionRequest(meta);
        },
        onTurnUsage: (usage) => {
          this.handleTurnUsage(usage);
        },
        onEvent: (event) => {
          this.projection.applyRuntimeEvent(event);
          void this.publish().catch(() => undefined);
        },
        resolveFile: async (reference) => {
          const bytes = this.resolvedFiles.get(reference);
          if (bytes === undefined)
            throw new Error(`Attached image ${reference} is not retained for this turn`);
          return bytes;
        },
      }),
    );

    const nativeId = this.session.nativeSession?.id;
    if (!nativeId) throw new Error('Native Claude requires a managed registration');
    this.sdkSession = await this.driver.open({
      profile,
      cwd: this.session.dir,
      nativeThreadId: nativeId,
      signal: this.sessionAbort.signal,
    });
    // Ensure the underlying query process spawns eagerly at open (verifyDelegation already starts
    // it for delegated sessions; for ordinary sessions initializationResult starts the loop now).
    if (this.session.delegation === undefined) {
      try {
        await this.sdkSession.initializationResult();
      } catch (error) {
        if (
          !(error instanceof Error && /does not support initializationResult/i.test(error.message))
        )
          throw error;
      }
    }
    if (this.sdkSession.providerPid !== undefined) this.providerPid = this.sdkSession.providerPid;
    this.projection.connected = true;
    await restoreMode(this.mailboxes);
    await loadCatalog(this.discovery);
    await loadCommands(this.discovery);
    await loadAccount(this.discovery);
    await refreshPlanLimits(this.discovery);
    await refreshMcpServers(this.discovery);
    this.serveContext(this.contextAbort.signal);
    this.serveLimits(this.contextAbort.signal);
    if (this.session.delegation !== undefined) {
      await registerRuntimeOwnership(this.m, this.session, this.providerPid);
    } else if (this.session.registrationGeneration !== undefined) {
      await registerRuntimeOwnership(this.m, this.session, this.providerPid).catch((error) => {
        log.warn({
          msg: 'native claude ownership registration skipped',
          name: this.session.name,
          err: String(error),
        });
      });
    }
    await recordDelegationApplied(this.m, this.session);
    await this.publish();
  }

  private handleQueryExit(error: unknown): void {
    this.failure ??= new Error('Native Claude stream failed', {
      cause: { error, stderr: this.providerDiagnostic },
    });
    this.projection.connected = false;
    this.pending.clear();
    if (this.projection.turn.status === 'inProgress') {
      this.projection.turn = advanceTurn(this.projection.turn, {
        step: 'failed',
        error: String(error),
      });
    }
    void this.report(error);
    void this.publish().catch(() => undefined);
  }

  private handlePermissionRequest(meta: ClaudeSdkPermissionRequestMeta): void {
    const request = approvalRequest(
      meta.interactionId,
      meta.toolName,
      meta.input,
      this.projection.turnId ?? meta.turnId,
    );
    this.pending.set(meta.interactionId, { request, toolName: meta.toolName });
    this.projection.content?.buffer.lifecycle(
      'request',
      request.turnId,
      meta.interactionId,
      'requested',
      request.reason,
    );
    this.projection.content?.publish();
    void this.publish().catch(() => undefined);
  }

  private handleTurnUsage(usage: ClaudeSdkTurnUsage): void {
    recordClaudeSdkUsage(this.m, this.session.uuid, this.usageEpoch, usage);
    this.projection.applyTurnUsage(usage);
  }

  private serveLimits(signal: AbortSignal): void {
    void (async () => {
      while (!signal.aborted) {
        try {
          await delay(PLAN_LIMITS_TICK_MS, undefined, { signal });
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
        if (signal.aborted) break;
        if (!planLimitsDue(this.projection.planLimits, Date.now())) continue;
        await refreshPlanLimits(this.discovery);
        await this.publish();
      }
    })();
  }

  /** Change the model for subsequent turns, keeping the published evidence in step. */
  async selectModel(model: string, turnId: string | null): Promise<void> {
    await this.sdkSession?.setModel(model);
    this.projection.selection = {
      model: { provider: 'claude', model },
      options: { runtime: 'claude', model: { provider: 'claude', model } },
      source: 'settings',
      turnId,
    };
    await this.publish();
  }

  private async startAndDrainTurn(input: {
    turnId: string;
    clientId: string;
    parts: AgentMessagePart[];
  }): Promise<void> {
    const sdkSession = this.sdkSession;
    if (sdkSession === null) throw new Error('Native Claude session is not open');
    const turn = await sdkSession.startTurn({
      turnId: input.turnId,
      clientId: input.clientId,
      input: input.parts,
    });
    this.activeTurn = turn;
    void this.drainTurn(turn);
  }

  private async drainTurn(turn: AgentEngineTurn): Promise<void> {
    try {
      for await (const delta of turn.deltas) {
        if (delta.type === 'request-resolved') {
          this.pending.delete(delta.interactionId);
        }
        this.projection.applyDelta(delta);
        if (this.projection.turn.status !== null && this.projection.turn.status !== 'inProgress') {
          await refreshContextUsage(this.discovery);
          await refreshPlanLimits(this.discovery);
        }
        await this.publish();
      }
    } catch (error) {
      if (!this.sessionAbort.signal.aborted) {
        this.failure ??= new Error('Native Claude stream failed', {
          cause: { error, stderr: this.providerDiagnostic },
        });
        this.projection.turn = advanceTurn(this.projection.turn, {
          step: 'failed',
          error: String(error),
        });
        await this.report(error);
      }
    } finally {
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
      this.resolvedFiles.clear();
      this.pending.clear();
      await this.publish().catch(() => undefined);
    }
  }

  private serveContext(signal: AbortSignal): void {
    const generation = this.session.registrationGeneration;
    if (!generation) return;
    this.contextPump.start(signal, async (contextSignal) => {
      const api = claudeContextApi(this.m, this.session, (inner) => this.compactTurn(inner));
      const wake = nativeContextWake(this.m, this.session, contextSignal);
      let pending = false;
      try {
        while (!contextSignal.aborted) {
          if (wake.changed() || pending) {
            await applyContextCommands(this.m, this.session, generation, api, contextSignal, () =>
              this.publishContextBoundary(),
            );
            pending = contextMutationPending(this.m, this.session);
          }
          await wake.wait(pending ? 200 : 60_000);
        }
      } finally {
        wake.close();
      }
    });
  }

  private async compactTurn(signal: AbortSignal): Promise<void> {
    const nativeId = `compact-${Date.now()}`;
    this.projection.turnId = nativeId;
    this.projection.turnStartedAt = new Date().toISOString();
    this.projection.turn = { ...this.projection.turn, status: 'inProgress', state: 'working' };
    this.resolvedFiles.clear();
    await this.startAndDrainTurn({
      turnId: nativeId,
      clientId: randomUUID(),
      parts: [{ type: 'text', text: '/compact' }],
    });
    await this.publish();
    signal.throwIfAborted();
  }

  private async publishContextBoundary(): Promise<void> {
    this.projection.content?.buffer.resetContext();
    this.projection.content?.publish();
    await this.projection.content?.writer.flushPending();
  }

  async tick(commandsChanged = true): Promise<void> {
    if (commandsChanged) {
      await applyInterrupt(this.mailboxes);
      await applyMode(this.mailboxes);
      await applyRewind(this.mailboxes);
      await applyMcpRequest(this.mailboxes);
      await applyResponse(this.mailboxes);
      this.pendingInput = true;
    }
    const input = this.pendingInput ? readRuntimeInput(this.m, this.session) : null;
    this.pendingInput = input !== null && input.phase !== 'accepted';
    if (
      input !== null &&
      input.phase !== 'accepted' &&
      (input.phase !== 'queued' || this.projection.turn.status !== 'inProgress')
    )
      await tryNativeAdmission(this.m, this.session, async () => {
        if (sleepBlocksStart(this.m, this.session)) return;
        await this.pickup.run({
          m: this.m,
          session: this.session,
          projection: this.projection,
          sdkSession: this.sdkSession,
          selectModel: (model, turnId) => this.selectModel(model, turnId),
          setResolvedFiles: (files) => {
            this.resolvedFiles = files;
          },
          startTurn: (turnInput) => this.startAndDrainTurn(turnInput),
        });
      });
    await this.publish();
  }

  private async publish(): Promise<void> {
    const generation = this.session.registrationGeneration;
    const threadId = this.session.nativeSession?.id;
    if (!generation || !threadId) return;
    await this.writer.write({
      ...this.projection.snapshot(
        {
          machine: this.m.rcPrefix,
          session: this.session.name,
          threadId,
          generation,
          pid: process.pid,
          providerPid: this.providerPid,
          version: this.session.nativeSession?.version ?? 'unknown',
        },
        [...this.pending.values()].map((entry) => entry.request),
        this.session.fileCheckpoints === true,
      ),
      registrationGeneration: generation,
      nativeSession: this.session.nativeSession,
    });
  }

  async close(): Promise<void> {
    this.contextAbort.abort();
    this.sessionAbort.abort();
    await this.contextPump.close();
    this.pending.clear();
    this.resolvedFiles.clear();
    this.projection.connected = false;
    try {
      await Promise.race([this.sdkSession?.close() ?? Promise.resolve(), Bun.sleep(2_000)]);
    } catch {
      // Best effort at shutdown; the session is going away either way.
    }
    this.activeTurn = null;
    this.sdkSession = null;
    await this.publish().catch(() => undefined);
    await this.projection.content?.close().catch(() => undefined);
  }
}
