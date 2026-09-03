import { randomUUID } from 'node:crypto';
import { statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EffortLevel,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveMessageAttachments } from '../../../attachments/pins.ts';
import { ContentProducer } from '../../../content/producer.ts';
import { claudeContextApi } from '../../../context/claude.ts';
import {
  admitNativeFork,
  type NativeForkIntent,
  readNativeForkIntent,
} from '../../../context/fork.ts';
import { applyContextCommands, NativeContextPump } from '../../../context/pump.ts';
import { tryNativeAdmission } from '../../../runtime/admission.ts';
import {
  type RuntimeInput,
  readRuntimeInput,
  runtimeInputPath,
  writeRuntimeInput,
} from '../../../runtime/input.ts';
import { planLimitsDue } from '../../../runtime/planLimits.ts';
import type { NativeSnapshot } from '../../../runtime/projectionSchema.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../../../runtime/status.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { atomicWrite } from '../../../util/atomic.ts';

/** How often the sample is CHECKED, not how often it is read: `planLimitsDue` decides the read. */
const PLAN_LIMITS_TICK_MS = 15_000;

import { classifySdkMessage, isFailureResult, summarise } from './content.ts';
import {
  type Discovery,
  loadAccount,
  loadCatalog,
  loadCommands,
  refreshContextUsage,
  refreshMcpServers,
  refreshPlanLimits,
} from './discovery.ts';
import {
  applyInterrupt,
  applyMcpRequest,
  applyMode,
  applyResponse,
  applyRewind,
  type Mailboxes,
  restoreMode,
} from './mailboxes.ts';
import {
  approvalKind,
  declaresDialogs,
  permissionResult,
  SUPPORTED_DIALOG_KINDS,
} from './permission.ts';
import { nativeInputDelivered } from './pickup.ts';
import { NativeProjection } from './projection.ts';
import { PromptQueue } from './promptQueue.ts';
import { resolveAgentSdk } from './resolve.ts';
import { resumesConversation } from './resume.ts';
import { composeSnapshot } from './snapshot.ts';
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

export interface PendingApproval {
  request: NativeSnapshot['pendingRequests'][number];
  /** The REAL tool name, kept apart from the human summary — a rule keyed on prose matches nothing. */
  toolName: string;
  settle: (result: PermissionResult) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeNativeOwner {
  private writer: ManagedRuntimeStatusWriter;
  private queue = new PromptQueue();
  private query: Query | null = null;
  private dispatched: string | null = null;
  private started = false;
  private failure: unknown = null;
  private pending = new Map<string, PendingApproval>();
  /** Everything this session publishes about itself, and the only thing that changes it. */
  private projection = new NativeProjection();

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
    const resolved = resolveAgentSdk(this.m);
    if ('unavailable' in resolved) throw new Error(resolved.detail);
    // A runtime path from host configuration — which is also why no bundler can see it and no host
    // that leaves the mode off ever loads it.
    const sdk = (await import(resolved.path)) as {
      query: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
      forkSession?: (
        id: string,
        options?: { upToMessageId?: string },
      ) => Promise<{ sessionId: string }>;
    };
    // A fork destination continues a conversation the runtime created for it, so its identity is
    // whatever `forkSession` returned — not the pinned generation a first-start session uses.
    const forkIntent = readNativeForkIntent(this.m, this.session);
    if (forkIntent !== null) await this.adoptFork(sdk, forkIntent);
    const managedId = this.session.nativeSession.id;
    const options = {
      pathToClaudeCodeExecutable: this.m.claudeBin,
      cwd: this.session.dir,
      // Without these two the runtime is a bare agent loop wearing Claude's model, not Claude Code:
      // no product system prompt, no CLAUDE.md, none of the operator's settings.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      // Only when the session asked for it: without this the runtime keeps no copies, and a rewind
      // has nothing to restore from — which is the honest state for a session nobody opted in.
      ...(this.session.fileCheckpoints === true ? { enableFileCheckpointing: true } : {}),
      permissionMode: 'default',
      // A chosen model is a turn option, not a different kind of session: the runtime family stays
      // `claude` and only the model within it changes.
      ...(this.session.modelSelection === undefined
        ? {}
        : { model: this.session.modelSelection.model }),
      canUseTool: (toolName: string, input: unknown) => this.decide(toolName, input),
      ...(declaresDialogs() ? { supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS] } : {}),
      // The id is pinned rather than discovered, so the managed identity and the runtime's own are
      // the same value. `sessionId` names a NEW conversation and cannot combine with `resume`.
      ...(this.started ? { resume: managedId } : { sessionId: managedId }),
    } as unknown as Options;
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

  /**
   * Take on the conversation a fork produced, exactly once.
   *
   * The admission ledger — not this method — is what makes it once: a fork whose acknowledgement was
   * lost must never be dispatched twice, because the second one silently duplicates a conversation.
   * The runtime chooses the new id, so the destination's pinned identity is replaced by it here and
   * the started marker is written, since the conversation exists from the moment the fork returns.
   */
  private async adoptFork(
    sdk: {
      forkSession?: (
        id: string,
        options?: { upToMessageId?: string },
      ) => Promise<{ sessionId: string }>;
    },
    intent: NativeForkIntent,
  ): Promise<void> {
    if (!sdk.forkSession) throw new Error('This runtime build cannot fork a conversation');
    const forkSession = sdk.forkSession;
    const result = await admitNativeFork(
      this.m,
      this.session,
      {
        fork: (source) =>
          // A branch point must be a TRANSCRIPT message uuid. A turn id here is the runtime's own
          // message id or a mailbox id this project minted, and neither is one — passing it made
          // the runtime refuse the fork outright. Anything else means the whole conversation, which
          // is what a fork with no chosen point is.
          forkSession(
            source.nativeId,
            source.turnId !== null && UUID.test(source.turnId)
              ? { upToMessageId: source.turnId }
              : {},
          ),
        identity: (response) => response.sessionId,
        // Already accepted: the conversation exists and its id is the answer, so nothing is asked
        // of the runtime a second time.
        resume: async (nativeId) => ({ sessionId: nativeId }),
      },
      AbortSignal.timeout(60_000),
    );
    this.session = {
      ...this.session,
      nativeSession: {
        runtime: 'claude',
        id: result.sessionId,
        version: this.session.nativeSession?.version ?? 'unknown',
      },
    };
    void intent;
    this.started = true;
    await atomicWrite(this.startedFile, 'started', 0o600);
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
    const request: NativeSnapshot['pendingRequests'][number] = {
      requestId,
      rpcId: requestId,
      kind: 'approval',
      approvalKind: approvalKind(toolName),
      turnId: this.projection.turnId ?? 'unknown',
      itemId: requestId,
      // The arguments travel with the request; deciding without them is the same blind answer the
      // drawn menu forced.
      reason: summarise(toolName, input),
      scope: null,
      decisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      questions: [],
      requestedAt: new Date().toISOString(),
    };
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
    await tryNativeAdmission(this.m, this.session, () => this.pickup());
    await this.publish();
  }

  /**
   * Adopt a dispatch the previous process did not finish recording.
   *
   * `dispatching` is written before the turn is queued and `accepted` after, so a process that
   * dies between them leaves a phase no later tick would look at again — the turn sat there and
   * the sender waited for an acknowledgement that could never come. The runtime's own transcript
   * decides which of the two happened; this only acts on the answer.
   */
  private async reconcileDispatch(input: RuntimeInput): Promise<void> {
    if (input.nativeId === this.dispatched) return;
    // A record written before the dispatch time was carried still knows when it was written: the
    // mailbox file's own timestamp is that moment. Without this the whole population this fix
    // exists for — the sessions already parked by an earlier build — would be judged undelivered
    // and sent a second time, which is the harm the reconciliation is meant to avoid.
    const dispatchedAt =
      input.dispatchedAt ?? statSync(runtimeInputPath(this.m, this.session)).mtime.toISOString();
    if (nativeInputDelivered(this.session, input, dispatchedAt)) {
      this.dispatched = input.nativeId;
      await writeRuntimeInput(this.m, this.session, { ...input, phase: 'accepted' });
      return;
    }
    // Back to the queue rather than failed: nothing was sent, so the turn is exactly as unsent as
    // it was before, and the next tick dispatches it normally.
    await writeRuntimeInput(this.m, this.session, { ...input, phase: 'queued' });
  }

  private async pickup(): Promise<void> {
    const pending = readRuntimeInput(this.m, this.session);
    if (pending?.phase === 'dispatching') await this.reconcileDispatch(pending);
    const input = readRuntimeInput(this.m, this.session);
    if (
      input &&
      input.phase === 'queued' &&
      input.nativeId !== this.dispatched &&
      // One turn at a time. Dispatching a second while the first runs retags its items, lets its
      // result close the wrong turn, and points an interrupt at a turn that is not running.
      this.projection.turn.status !== 'inProgress'
    ) {
      this.dispatched = input.nativeId;
      this.projection.turnId = input.nativeId;
      this.projection.turnStartedAt = new Date().toISOString();
      this.projection.turn = { ...this.projection.turn, status: 'inProgress', state: 'working' };
      // `dispatching` before the queue, `accepted` after: a crash between the two is then visible as
      // an in-flight dispatch rather than as a delivered message that never arrived.
      await writeRuntimeInput(this.m, this.session, {
        ...input,
        phase: 'dispatching',
        dispatchedAt: this.projection.turnStartedAt,
      });
      const options = input.turnOptions?.options;
      if (options?.runtime === 'claude') {
        // A turn's own model and effort, applied before it is queued so they govern this turn rather
        // than the one after it.
        if (options.model.model !== this.projection.selection?.model.model)
          await this.selectModel(options.model.model, input.nativeId);
        // The runtime has no per-turn effort setter: `applyFlagSettings` sets it for the rest of
        // the session on models that accept it. Applied here so the turn that asked for it is the
        // first one governed by it, and stated as session-scoped rather than pretended per-turn.
        if (options.effort !== undefined)
          // The level came from this runtime's own catalog and was checked against it before the
          // turn was admitted, so it is a name the runtime published — the cast restates that,
          // rather than narrowing it here to a list this file would then have to keep current.
          await this.query?.applyFlagSettings?.({
            effortLevel: options.effort as EffortLevel,
          });
      }
      this.queue.push({
        type: 'user',
        session_id: this.session.nativeSession?.id ?? '',
        parent_tool_use_id: null,
        message: { role: 'user', content: await this.blocks(input) },
      } as SDKUserMessage);
      await writeRuntimeInput(this.m, this.session, { ...input, phase: 'accepted' });
    }
  }

  /**
   * The turn's content: its text, and any images the caller pinned to the message.
   *
   * Resolved here rather than earlier because the bytes are owner-only — a data URL must never
   * reach a receipt or a status file. An image that cannot be resolved fails the turn instead of
   * being dropped: the caller attached it deliberately, and answering without it would answer a
   * different question than the one asked.
   */
  private async blocks(input: {
    text: string;
    images?: readonly unknown[] | undefined;
    messageId: string;
  }) {
    const references = input.images ?? [];
    if (references.length === 0) return input.text;
    const resolved = await resolveMessageAttachments(
      this.m,
      this.session,
      input.messageId,
      references as never,
      AbortSignal.timeout(10_000),
      'data-url',
    );
    // Resolution returning FEWER images than were attached is the silent-loss case, not a smaller
    // turn: the caller attached them deliberately, and answering without one answers a different
    // question. Checked before the shape of any single image, because the count is what goes missing
    // when a pin is absent.
    if (resolved.length !== references.length)
      throw new Error(
        `Attached images are not retained: ${references.length} sent, ${resolved.length} resolved`,
      );
    const images = resolved.map((item) => {
      const match = /^data:([^;]+);base64,(.*)$/.exec(item.dataUrl ?? '');
      if (!match?.[1] || !match[2]) throw new Error('Attached image is not retained');
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: match[1], data: match[2] },
      };
    });
    // Images first, then the text that refers to them — the order a person writes them in.
    return [...images, { type: 'text' as const, text: input.text }];
  }

  private async publish(): Promise<void> {
    const generation = this.session.registrationGeneration;
    const threadId = this.session.nativeSession?.id;
    if (!generation || !threadId) return;
    await this.writer.write({
      ...composeSnapshot({
        identity: {
          machine: this.m.rcPrefix,
          session: this.session.name,
          threadId,
          generation,
          pid: process.pid,
          providerPid: process.pid,
          version: this.session.nativeSession?.version ?? 'unknown',
        },
        sequence: this.projection.sequence,
        connected: this.projection.connected,
        turn: this.projection.turn,
        turnId: this.projection.turnId,
        turnStartedAt: this.projection.turnStartedAt,
        items: this.projection.items,
        pending: [...this.pending.values()].map((entry) => entry.request),
        selection: this.projection.selection,
        permissionMode: this.projection.permissionMode,
        contextUsage: this.projection.contextUsage,
        planLimits: this.projection.planLimits,
        account: this.projection.account,
        spend: this.projection.spend,
        fileCheckpoints: this.session.fileCheckpoints === true,
        mcpServers: this.projection.mcpServers,
        now: Date.now(),
      }),
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
