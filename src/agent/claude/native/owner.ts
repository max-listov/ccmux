import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CHAT_CREDENTIAL_ENV, rotateChatCredential } from '../../../chat/auth.ts';
import { ContentProducer } from '../../../content/producer.ts';
import { claudeContextApi } from '../../../context/claude.ts';
import { readNativeForkIntent } from '../../../context/fork.ts';
import { applyContextCommands, NativeContextPump } from '../../../context/pump.ts';
import { tryNativeAdmission } from '../../../runtime/admission.ts';
import { planLimitsDue } from '../../../runtime/planLimits.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../../../runtime/status.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { recordClaudeSdkUsage } from '../../../usage/claudeSdk.ts';
import { atomicWrite } from '../../../util/atomic.ts';
import { launchEnv } from '../launch.ts';
import { classifySdkMessage, isFailureResult } from './content.ts';
import {
  type Discovery,
  loadAccount,
  loadCatalog,
  loadCommands,
  refreshContextUsage,
  refreshMcpServers,
  refreshPlanLimits,
} from './discovery.ts';
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
import { approvalRequest, type PendingApproval, permissionResult } from './permission.ts';
import { TurnPickup } from './pickup.ts';
import { NativeProjection } from './projection.ts';
import { PromptQueue } from './promptQueue.ts';
import { resumesConversation } from './resume.ts';
import { loadAgentSdk, sdkOptions } from './sdk.ts';
import { advanceTurn } from './turn.ts';

/**
 * The writer for one native Claude conversation.
 *
 * Everything that decides anything lives in the pure modules beside this file; what is here is the
 * I/O around them. Two invariants govern the whole class, because breaking either produces the lie
 * this execution mode exists to remove:
 *
 * - **A dead runtime never reports itself alive.** The stream ending is a fact about the runtime, so
 *   it always reaches `connected` and always reaches the supervisor as a failure, whether the stream
 *   ended by throwing or by simply finishing.
 * - **Nothing waits on a promise nobody will settle.** Every permission callback held here is
 *   settled on every exit — answered, interrupted, or closed.
 */

/** How often the sample is CHECKED, not how often it is read: `planLimitsDue` decides the read. */
const PLAN_LIMITS_TICK_MS = 15_000;

export class ClaudeNativeOwner {
  private writer: ManagedRuntimeStatusWriter;
  private queue = new PromptQueue();
  private query: Query | null = null;
  private pickup = new TurnPickup();
  private started = false;
  private failure: unknown = null;
  private pending = new Map<string, PendingApproval>();
  /** Everything this session publishes about itself, and the only thing that changes it. */
  private projection = new NativeProjection();
  private usageEpoch = crypto.randomUUID();

  /** What the six requests need. Assembled rather than passed piecemeal, so adding one is one line. */
  private get mailboxes(): Mailboxes {
    return {
      m: this.m,
      session: this.session,
      query: this.query,
      projection: this.projection,
      discovery: this.discovery,
      pending: this.pending,
      publish: () => this.publish(),
      report: this.report,
      settleAll: (decision) => this.settleAll(decision),
    };
  }

  /** What the five description reads need, and nothing else this owner holds. */
  private get discovery(): Discovery {
    return {
      m: this.m,
      session: this.session,
      query: this.query,
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

  private get startedFile(): string {
    return join(managedRuntimeRoot(this.m, this.session), 'conversation.started');
  }

  private contextAbort = new AbortController();

  private contextPump: NativeContextPump = new NativeContextPump((error) => {
    void this.report(error);
  });

  /** The session as this owner resolved it — a fork changes the conversation it points at. */
  get identity(): Session {
    return this.session;
  }

  /** Whatever ended the runtime, so the supervising loop can stop rather than publish a corpse. */
  get failed(): unknown {
    return this.failure;
  }

  async open(): Promise<void> {
    const generation = this.session.registrationGeneration;
    if (!generation || !this.session.nativeSession)
      throw new Error('Native Claude requires a managed registration');
    this.projection.content = new ContentProducer(this.m, this.session, generation);
    this.started = resumesConversation(this.m, this.session, this.startedFile);
    const sdk = await loadAgentSdk(this.m);
    // A fork destination continues a conversation the runtime created for it, so its identity is
    // whatever `forkSession` returned — not the pinned generation a first-start session uses.
    if (readNativeForkIntent(this.m, this.session) !== null) {
      this.session = await adoptNativeFork(this.m, this.session, sdk);
      this.started = true;
      await atomicWrite(this.startedFile, 'started', 0o600);
    }
    const env = launchEnv(this.m, this.session);
    env[CHAT_CREDENTIAL_ENV] = rotateChatCredential(this.m, this.session);
    const options = sdkOptions({
      m: this.m,
      session: this.session,
      env,
      started: this.started,
      canUseTool: (toolName, input) => this.decide(toolName, input),
    });
    this.usageEpoch = crypto.randomUUID();
    this.query = sdk.query({ prompt: this.queue.iterable(), options });
    this.projection.connected = true;
    void this.drain();
    await restoreMode(this.mailboxes);
    await loadCatalog(this.discovery);
    await loadCommands(this.discovery);
    await loadAccount(this.discovery);
    await refreshPlanLimits(this.discovery);
    await refreshMcpServers(this.discovery);
    this.serveContext(this.contextAbort.signal);
    this.serveLimits(this.contextAbort.signal);
    await this.publish();
  }

  /**
   * Ask again when the sample has stopped describing the present.
   *
   * The end of a turn is not the only moment the answer can change, which is what the refresh at
   * the end of `drain` assumed. A window RESETS on a clock, and a sibling session on the same
   * account spends against the same window — so between two turns of this session the number can
   * move both ways. Measured: a five-hour window that reset at 06:29Z was served as 100 % full at
   * 08:05Z while the runtime's own display read 36 %, and the session had been working throughout.
   *
   * The check is cheap and the read is not, so the tick is frequent and `planLimitsDue` decides:
   * an unexpired sample younger than its maximum age costs one comparison.
   */
  private serveLimits(signal: AbortSignal): void {
    void (async () => {
      while (!signal.aborted) {
        await Bun.sleep(PLAN_LIMITS_TICK_MS);
        if (signal.aborted) break;
        if (!planLimitsDue(this.projection.planLimits, Date.now())) continue;
        await refreshPlanLimits(this.discovery);
        await this.publish();
      }
    })();
  }

  /** Change the model for subsequent turns, keeping the published evidence in step. */
  async selectModel(model: string, turnId: string | null): Promise<void> {
    await this.query?.setModel?.(model);
    this.projection.selection = {
      model: { provider: 'claude', model },
      options: { runtime: 'claude', model: { provider: 'claude', model } },
      source: 'settings',
      turnId,
    };
    await this.publish();
  }

  /**
   * Consume the runtime's stream for the life of the session.
   *
   * The `finally` is the point. A stream that simply ENDS — the child exited, the transport closed —
   * is exactly as fatal as one that throws, and handling only the throwing case left a session
   * publishing `connected: true` with a fresh lease every 200 ms over a runtime that was gone.
   */
  private async drain(): Promise<void> {
    const query = this.query;
    if (!query) return;
    try {
      for await (const message of query) {
        await this.rememberConversation();
        recordClaudeSdkUsage(this.m, this.session.uuid, this.usageEpoch, message);
        const failed = isFailureResult(message);
        const classified = classifySdkMessage(message.type);
        this.projection.turn = advanceTurn(this.projection.turn, {
          step: 'message',
          message: classified,
          kind: null,
          failed,
        });
        if ('kind' in classified) this.projection.record(message, classified.kind, failed);
        this.projection.takeSpend(message);
        this.projection.takeRateLimit(message);
        // Measured when a turn ends, not on every frame: this is a round trip to the runtime, and
        // the answer only changes when the conversation does.
        if (this.projection.turn.status !== null && this.projection.turn.status !== 'inProgress') {
          await refreshContextUsage(this.discovery);
          // A turn is one of the moments the answer can have changed; the other is the clock, and
          // a sibling session on the same account. `serveLimits` covers those.
          await refreshPlanLimits(this.discovery);
        }
        await this.publish();
      }
      this.failure ??= new Error('Native Claude stream ended while the session was alive');
    } catch (error) {
      this.failure = error;
      this.projection.turn = advanceTurn(this.projection.turn, {
        step: 'failed',
        error: String(error),
      });
      await this.report(error);
    } finally {
      this.projection.connected = false;
      // Nothing will answer these now; leaving them unsettled holds the runtime's own callbacks.
      this.settleAll('cancel');
      await this.publish().catch(() => undefined);
      await this.recoverStaleConversation();
    }
  }

  /**
   * A resume that names a conversation the runtime does not have is not recoverable by retrying —
   * it fails identically forever. Clearing the marker turns the next start back into a first start,
   * which is the only state the runtime will accept.
   */
  private async recoverStaleConversation(): Promise<void> {
    if (!/No conversation found/i.test(String(this.failure ?? ''))) return;
    try {
      unlinkSync(this.startedFile);
      await this.report(
        new Error('Cleared a stale conversation marker; the next start creates one'),
      );
    } catch {
      // Already gone; the next start creates the conversation anyway.
    }
  }

  private settleAll(decision: 'cancel' | 'decline'): void {
    for (const [id, entry] of this.pending) {
      entry.settle(permissionResult(decision, { toolName: entry.toolName }));
      this.pending.delete(id);
    }
  }

  /** The first message proves the conversation now exists, so the next start must resume it. */
  private async rememberConversation(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await atomicWrite(this.startedFile, 'created\n', 0o600);
  }

  /**
   * Ask the operator, and wait for their answer.
   *
   * In the terminal mode this same request is a drawn menu nothing can answer through the control
   * plane, so the session strands while every other signal calls it idle. There is deliberately no
   * timeout: an unanswered request leaves the session visibly `waiting-approval`, which a person can
   * act on, whereas a timeout that declined on its own would make a decision nobody made.
   */
  private async decide(toolName: string, input: unknown): Promise<PermissionResult> {
    const requestId = randomUUID();
    const request = approvalRequest(
      requestId,
      toolName,
      input,
      this.projection.turnId ?? 'unknown',
    );
    const settled = new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { request, toolName, settle: resolve });
    });
    this.projection.turn = advanceTurn(this.projection.turn, {
      step: 'message',
      message: { kind: 'request' },
      kind: 'approval',
    });
    this.projection.content?.buffer.lifecycle(
      'request',
      request.turnId,
      requestId,
      'requested',
      request.reason,
    );
    this.projection.content?.publish();
    await this.publish();
    return settled;
  }

  /**
   * Serve the context operations from inside the process that holds the connection.
   *
   * One task, not one per tick: history reads and compaction are serialized by the pump, and a
   * second concurrent pass would answer a mailbox request the first one is already answering.
   */
  private serveContext(signal: AbortSignal): void {
    const generation = this.session.registrationGeneration;
    if (!generation) return;
    this.contextPump.start(signal, async (contextSignal) => {
      const api = claudeContextApi(this.m, this.session, (inner) => this.compactTurn(inner));
      while (!contextSignal.aborted) {
        await applyContextCommands(this.m, this.session, generation, api, contextSignal, () =>
          this.publishContextBoundary(),
        );
        await Bun.sleep(200);
      }
    });
  }

  /**
   * Compaction is the runtime's own command, delivered on the path phase 1 already built.
   *
   * A second mechanism for it would be a second way to reach the same conversation, which is the
   * one thing this runtime's single-writer rule exists to prevent.
   */
  private async compactTurn(signal: AbortSignal): Promise<void> {
    const nativeId = `compact-${Date.now()}`;
    this.projection.turnId = nativeId;
    this.projection.turnStartedAt = new Date().toISOString();
    this.projection.turn = { ...this.projection.turn, status: 'inProgress', state: 'working' };
    this.queue.push({
      type: 'user',
      session_id: this.session.nativeSession?.id ?? '',
      parent_tool_use_id: null,
      message: { role: 'user', content: '/compact' },
    } as SDKUserMessage);
    await this.publish();
    signal.throwIfAborted();
  }

  private async publishContextBoundary(): Promise<void> {
    this.projection.content?.buffer.resetContext();
    this.projection.content?.publish();
    await this.projection.content?.writer.flushPending();
  }

  async tick(): Promise<void> {
    await applyInterrupt(this.mailboxes);
    await applyMode(this.mailboxes);
    await applyRewind(this.mailboxes);
    await applyMcpRequest(this.mailboxes);
    await applyResponse(this.mailboxes);
    // Pickup under the same lock the writers take, so a write cannot interleave with the
    // read-then-write that moves a turn between phases. Attempted rather than awaited to the
    // timeout: this process also serves the session's context operations under that same lock, and
    // a pickup that insisted would eventually throw and take the runtime down with it. A busy tick
    // simply leaves the turn where it is.
    await tryNativeAdmission(this.m, this.session, () =>
      this.pickup.run({
        m: this.m,
        session: this.session,
        projection: this.projection,
        queue: this.queue,
        query: this.query,
        selectModel: (model, turnId) => this.selectModel(model, turnId),
      }),
    );
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
          providerPid: process.pid,
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
    await this.contextPump.close();
    this.settleAll('decline');
    this.queue.close();
    this.projection.connected = false;
    try {
      // Bounded: shutdown must not hang inside the owner lock waiting on a runtime that is gone.
      await Promise.race([this.query?.interrupt?.() ?? Promise.resolve(), Bun.sleep(2_000)]);
    } catch {
      // Best effort at shutdown; the session is going away either way.
    }
    await this.publish().catch(() => undefined);
    await this.projection.content?.close().catch(() => undefined);
  }
}
