import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
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
import { readRuntimeInput, writeRuntimeInput } from '../../../runtime/input.ts';
import {
  isCancellableTurn,
  readRuntimeInterrupt,
  writeRuntimeInterrupt,
} from '../../../runtime/interrupt.ts';
import { readRuntimeMcpRequest, writeRuntimeMcpRequest } from '../../../runtime/mcpControl.ts';
import type { NativeSnapshot, PermissionMode } from '../../../runtime/projectionSchema.ts';
import { readRuntimeRewind, writeRuntimeRewind } from '../../../runtime/rewind.ts';
import { RewindResultSchema } from '../../../runtime/rewindSchema.ts';
import {
  readRuntimeMode,
  shouldRestoreMode,
  writeRuntimeMode,
} from '../../../runtime/sessionMode.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../../../runtime/status.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { atomicWrite } from '../../../util/atomic.ts';
import {
  clearNativeCommand,
  readNativeCommand,
  readNativeReceipt,
  writeNativeReceipt,
} from '../../codex/ownedControl.ts';
import { accountIsEmpty, nativeAccount, type ReportedAccount } from './account.ts';
import { claudeModels, type SupportedModel, writeClaudeCatalog } from './catalog.ts';
import { claudeCommands, type SupportedCommand, writeClaudeCommands } from './commands.ts';
import { classifySdkMessage } from './content.ts';
import { nativeContextUsage, type ReportedContextUsage } from './context.ts';
import { nativeMcpServers, type ReportedMcpServer } from './mcp.ts';
import {
  approvalKind,
  declaresDialogs,
  permissionResult,
  SUPPORTED_DIALOG_KINDS,
} from './permission.ts';
import { resolveAgentSdk } from './resolve.ts';
import { composeSnapshot } from './snapshot.ts';
import { advanceTurn, initialTurn, type TurnState } from './turn.ts';
import { nativeUsage, type SdkModelUsage, turnDelta } from './usage.ts';

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

/** Bounded so a long session cannot grow the published observation without limit. */
const MAX_ITEMS = 256;

/** A queue the runtime pulls turns from. One long-lived session, not one process per turn. */
class PromptQueue {
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  private pending: SDKUserMessage[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const next = this.waiting.shift();
    if (next) next({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined as never, done: true });
  }

  iterable(): AsyncIterable<SDKUserMessage> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const ready = this.pending.shift();
          if (ready) return Promise.resolve({ value: ready, done: false });
          if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
            this.waiting.push(resolve),
          );
        },
      }),
    };
  }
}

interface PendingApproval {
  request: NativeSnapshot['pendingRequests'][number];
  /** The REAL tool name, kept apart from the human summary — a rule keyed on prose matches nothing. */
  toolName: string;
  settle: (result: PermissionResult) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeNativeOwner {
  private writer: ManagedRuntimeStatusWriter;
  private content: ContentProducer | null = null;
  private queue = new PromptQueue();
  private query: Query | null = null;
  private turn: TurnState = initialTurn;
  private turnId: string | null = null;
  private turnStartedAt: string | null = null;
  private items: NativeSnapshot['nativeItems'] = [];
  private sequence = 0;
  private connected = false;
  private dispatched: string | null = null;
  private started = false;
  private failure: unknown = null;
  private usageSoFar: Record<string, SdkModelUsage> = {};
  private pending = new Map<string, PendingApproval>();
  /** Item ids per turn, so a text stream coalesces instead of one item per fragment. */
  private textItem = new Map<string, number>();
  /** What the runtime is actually using, published so a reader never has to guess. */
  private selection: NativeSnapshot['nativeSelection'] = null;

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

  /**
   * The mode the next turn runs under. Held here because the runtime has no getter: what a session
   * publishes must be what it last successfully applied, not what someone hoped it applied.
   */
  private permissionMode: PermissionMode = 'default';

  /** The last context measurement the runtime gave, refreshed when a turn ends rather than per tick. */
  private contextUsage: NativeSnapshot['contextUsage'];

  /** Which account this session runs on, asked once — it does not change while a session lives. */
  private account: NativeSnapshot['account'];

  /** The session's MCP servers and their connection status, refreshed when one is acted on. */
  private mcpServers: NativeSnapshot['mcpServers'];

  /** Cumulative spend, as the runtime reports it at the end of each turn. */
  private spend: NativeSnapshot['spend'];

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
    this.content = new ContentProducer(this.m, this.session, generation);
    this.started = existsSync(this.startedFile);
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
    this.connected = true;
    void this.drain();
    await this.restoreMode();
    await this.loadCatalog();
    await this.loadCommands();
    await this.loadAccount();
    await this.refreshMcpServers();
    this.serveContext(this.contextAbort.signal);
    await this.publish();
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

  /**
   * Ask the runtime what it can run, once, and leave the answer where a catalog read can find it.
   *
   * Only this process holds a connection, and the read runs elsewhere — so a list nobody published
   * would have to be invented by the reader, which is exactly the kind of plausible answer this
   * project refuses to give. A runtime that cannot answer leaves no file, and the read says
   * unavailable rather than guessing.
   */
  private async loadCatalog(): Promise<void> {
    try {
      const supported = (await this.query?.supportedModels?.()) as SupportedModel[] | undefined;
      if (!supported) return;
      const chosen = this.session.modelSelection?.model ?? null;
      const models = claudeModels(supported, chosen);
      await writeClaudeCatalog(this.m, this.session, models);
      const current = models.find((model) => model.isDefault) ?? models[0];
      if (current)
        this.selection = {
          model: { provider: 'claude', model: current.id },
          options: { runtime: 'claude', model: { provider: 'claude', model: current.id } },
          source: this.session.modelSelection === undefined ? 'settings' : 'admission',
          turnId: null,
        };
    } catch (error) {
      // A catalog is enrichment, not a precondition: a session that cannot list models still runs.
      await this.report(error);
    }
  }

  /**
   * Ask the runtime which slash commands it offers, and leave the answer where a read can find it.
   *
   * Same reason as the model catalog: the reader runs elsewhere. A session that cannot answer leaves
   * no file, and the read says unavailable rather than offering a vocabulary nobody verified.
   */
  private async loadCommands(): Promise<void> {
    try {
      const supported = (await this.query?.supportedCommands?.()) as SupportedCommand[] | undefined;
      if (!supported) return;
      await writeClaudeCommands(this.m, this.session, claudeCommands(supported));
    } catch (error) {
      // A vocabulary is enrichment, not a precondition: a session that cannot list commands still runs.
      await this.report(error);
    }
  }

  /**
   * Ask which account this session runs on.
   *
   * Once, at start: the answer does not change while a session lives, and asking per turn would be
   * a round trip for a constant. A runtime that says nothing publishes nothing — an account nobody
   * named is not an account of unknown name.
   */
  private async loadAccount(): Promise<void> {
    try {
      const reported = (await this.query?.accountInfo?.()) as ReportedAccount | undefined;
      if (!reported) return;
      const account = nativeAccount(reported);
      if (!accountIsEmpty(account)) this.account = account;
    } catch (error) {
      await this.report(error);
    }
  }

  /**
   * Read the session's MCP servers and their connection status.
   *
   * A failed server is otherwise invisible: the only sign is a tool that quietly is not there, and
   * a supervisor that cannot say which server failed cannot help.
   */
  private async refreshMcpServers(): Promise<void> {
    try {
      const reported = (await this.query?.mcpServerStatus?.()) as ReportedMcpServer[] | undefined;
      if (!reported) return;
      this.mcpServers = nativeMcpServers(reported);
    } catch (error) {
      await this.report(error);
    }
  }

  /**
   * Enable, disable or reconnect one server, then publish what it looks like afterwards.
   *
   * Republishing is the point: a request the runtime accepted is not a server that works, and the
   * caller is answered from the refreshed status rather than from the acceptance.
   */
  private async applyMcpRequest(): Promise<void> {
    const request = readRuntimeMcpRequest(this.m, this.session);
    if (request === null || request.phase !== 'queued') return;
    if (request.generation !== this.session.registrationGeneration) return;
    try {
      if (request.action === 'reconnect') await this.query?.reconnectMcpServer?.(request.server);
      else await this.query?.toggleMcpServer?.(request.server, request.action === 'enable');
      await this.refreshMcpServers();
      await this.publish();
      await writeRuntimeMcpRequest(this.m, this.session, { ...request, phase: 'complete' });
    } catch (error) {
      await writeRuntimeMcpRequest(this.m, this.session, {
        ...request,
        phase: 'failed',
        reason: 'The runtime refused this MCP operation',
      });
      await this.report(error);
    }
  }

  /**
   * Ask the runtime how full its context window is.
   *
   * Failure is silence, not a fault: a measurement that cannot be taken leaves the previous one
   * standing, and a session that cannot answer still runs. Publishing a zero would be worse than
   * publishing nothing, because a zero reads as an empty window.
   */
  private async refreshContextUsage(): Promise<void> {
    try {
      const reported = (await this.query?.getContextUsage?.()) as ReportedContextUsage | undefined;
      if (!reported) return;
      this.contextUsage = nativeContextUsage(reported, Date.now());
    } catch (error) {
      await this.report(error);
    }
  }

  /** Change the model for subsequent turns, keeping the published evidence in step. */
  async selectModel(model: string, turnId: string | null): Promise<void> {
    await this.query?.setModel?.(model);
    this.selection = {
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
        this.turn = advanceTurn(this.turn, {
          step: 'message',
          message: classified,
          kind: null,
          failed,
        });
        if ('kind' in classified) this.record(message, classified.kind, failed);
        this.takeSpend(message);
        // Measured when a turn ends, not on every frame: this is a round trip to the runtime, and
        // the answer only changes when the conversation does.
        if (this.turn.status !== null && this.turn.status !== 'inProgress')
          await this.refreshContextUsage();
        await this.publish();
      }
      this.failure ??= new Error('Native Claude stream ended while the session was alive');
    } catch (error) {
      this.failure = error;
      this.turn = advanceTurn(this.turn, { step: 'failed', error: String(error) });
      await this.report(error);
    } finally {
      this.connected = false;
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

  private record(message: { type: string }, kind: string, failed: boolean): void {
    const turnId = this.turnId ?? 'unknown';
    if (kind === 'tool') {
      this.recordTool(message, turnId);
      return;
    }
    if (kind === 'terminal') {
      this.content?.buffer.lifecycle(
        'terminal',
        turnId,
        `${turnId}:end`,
        failed ? 'failed' : 'completed',
      );
      this.appendItem({
        kind: 'terminal',
        stage: 'completed',
        nativeId: `${turnId}:end`,
        turnId,
        requestId: null,
        status: failed ? 'failed' : 'completed',
        text: null,
        tool: null,
        usage: this.takeUsage(message),
      });
      this.content?.publish();
      return;
    }
    const text =
      message.type === 'stream_event' ? deltaText((message as { event?: unknown }).event) : null;
    if (text === null) return;
    // Coalesced: one item per turn's answer rather than one per fragment. The buffer appends, so a
    // reader sees the answer grow instead of a thousand disconnected pieces.
    const itemId = `${turnId}:text`;
    this.content?.buffer.text('assistant', turnId, itemId, text, 'append');
    this.content?.publish();
    const at = this.textItem.get(itemId);
    if (at === undefined) {
      this.textItem.set(
        itemId,
        this.appendItem({
          kind: 'assistant',
          stage: 'updated',
          nativeId: itemId,
          turnId,
          requestId: null,
          status: null,
          text,
          tool: null,
          usage: null,
        }),
      );
      return;
    }
    const existing = this.items[at];
    if (existing)
      this.items[at] = { ...existing, text: `${existing.text ?? ''}${text}`.slice(-8_192) };
  }

  /** Tool use and its result, which carry no text blocks and would otherwise vanish entirely. */
  private recordTool(message: { type: string }, turnId: string): void {
    for (const block of toolBlocks(message)) {
      this.content?.buffer.tool(turnId, block.callId, {
        callId: block.callId,
        name: block.name,
        lifecycle: block.lifecycle,
        outcome:
          block.lifecycle === 'completed' ? (block.failed ? 'failed' : 'succeeded') : 'unknown',
        exitCode: null,
      });
      this.appendItem({
        kind: 'tool',
        stage: block.lifecycle === 'completed' ? 'completed' : 'started',
        nativeId: block.callId,
        turnId,
        requestId: null,
        status: block.lifecycle,
        text: block.detail,
        tool: block.name,
        usage: null,
      });
    }
    this.content?.publish();
  }

  private appendItem(item: Omit<NativeSnapshot['nativeItems'][number], 'sequence' | 'at'>): number {
    this.sequence += 1;
    this.items.push({ ...item, sequence: this.sequence, at: new Date().toISOString() });
    // Trimmed at the source rather than only in the view, so memory is bounded too.
    if (this.items.length > MAX_ITEMS) {
      const dropped = this.items.length - MAX_ITEMS;
      this.items.splice(0, dropped);
      for (const [key, at] of this.textItem) {
        if (at < dropped) this.textItem.delete(key);
        else this.textItem.set(key, at - dropped);
      }
    }
    return this.items.length - 1;
  }

  /** The conversation's running cost, as the runtime states it — never derived from token counts. */
  private takeSpend(message: unknown): void {
    const record = message as { type?: unknown; total_cost_usd?: unknown };
    if (record.type !== 'result' || typeof record.total_cost_usd !== 'number') return;
    if (!Number.isFinite(record.total_cost_usd) || record.total_cost_usd < 0) return;
    this.spend = {
      totalCostUsd: record.total_cost_usd,
      observedAt: new Date().toISOString(),
    };
  }

  /** Per-turn spend, differenced against the running total the runtime keeps for the session. */
  private takeUsage(message: unknown): NativeSnapshot['nativeItems'][number]['usage'] {
    const record = message as { modelUsage?: Record<string, SdkModelUsage> };
    if (record.modelUsage === undefined) return nativeUsage({ reported: false });
    const delta = turnDelta(record.modelUsage, this.usageSoFar);
    this.usageSoFar = record.modelUsage;
    return nativeUsage({ reported: true, delta });
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
      turnId: this.turnId ?? 'unknown',
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
    this.turn = advanceTurn(this.turn, {
      step: 'message',
      message: { kind: 'request' },
      kind: 'approval',
    });
    this.content?.buffer.lifecycle(
      'request',
      request.turnId,
      requestId,
      'requested',
      request.reason,
    );
    this.content?.publish();
    await this.publish();
    return settled;
  }

  /** Apply one decision the control plane wrote, and acknowledge it. */
  private async applyResponse(): Promise<void> {
    const command = readNativeCommand(this.m, this.session.name);
    if (!command) return;
    const prior = readNativeReceipt(this.m, this.session.name);
    if (prior?.operationId === command.operationId) {
      clearNativeCommand(this.m, this.session.name);
      return;
    }
    const receipt = (outcome: 'submitted' | 'rejected' | 'uncertain', reason: string | null) =>
      writeNativeReceipt(this.m, this.session.name, {
        operationId: command.operationId,
        requestId: command.requestId,
        fingerprint: command.fingerprint,
        outcome,
        reason,
      });
    const waiting = this.pending.get(command.requestId);
    if (
      command.generation !== this.session.registrationGeneration ||
      !waiting ||
      command.kind !== 'approval' ||
      command.decision === null
    ) {
      // Refused rather than guessed: a response that does not match a request this runtime holds
      // would otherwise resume some other turn, or none.
      await receipt('rejected', 'request-identity-mismatch');
      clearNativeCommand(this.m, this.session.name);
      return;
    }
    // Written BEFORE the effect. A crash in the window then reads as uncertain, which is the truth;
    // writing only afterwards reported an applied decision as rejected on the next start.
    await receipt('uncertain', null);
    this.pending.delete(command.requestId);
    waiting.settle(permissionResult(command.decision, { toolName: waiting.toolName }));
    this.turn = advanceTurn(this.turn, { step: 'answered' });
    this.content?.buffer.lifecycle(
      'request',
      waiting.request.turnId,
      command.requestId,
      command.decision,
    );
    this.content?.publish();
    await receipt('submitted', null);
    clearNativeCommand(this.m, this.session.name);
    await this.publish();
  }

  /**
   * Cancel the running turn, leaving the runtime alive to answer for it.
   *
   * Outstanding permissions are settled with a cancel rather than abandoned: the runtime is holding
   * those callbacks, and interrupting behind their backs leaves them unresolved for the life of the
   * process while the snapshot claims the session is idle.
   */
  private async applyInterrupt(): Promise<void> {
    const command = readRuntimeInterrupt(this.m, this.session);
    if (command === null || !['queued', 'uncertain'].includes(command.phase)) return;
    const cancellable = () =>
      isCancellableTurn(
        {
          generation: this.session.registrationGeneration ?? '',
          state: this.turn.state,
          turn:
            this.turnId === null || this.turn.status === null
              ? null
              : { id: this.turnId, status: this.turn.status, startedAt: this.turnStartedAt },
        },
        command.generation,
        command.turnId,
      );
    if (!cancellable()) {
      await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'rejected' });
      return;
    }
    await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'uncertain' });
    // Writing yields, and the turn may settle in that gap. Re-checking is what stops this cancelling
    // whatever turn started next.
    if (!cancellable()) {
      await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'rejected' });
      return;
    }
    this.settleAll('cancel');
    try {
      await this.query?.interrupt?.();
    } catch (error) {
      // An interrupt that cannot be delivered is a rejected interrupt, not a dead session. Throwing
      // here would destroy the conversation the contract promises to keep.
      await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'rejected' });
      await this.report(error);
      return;
    }
    this.turn = advanceTurn(this.turn, { step: 'interrupted' });
    await writeRuntimeInterrupt(this.m, this.session, { ...command, phase: 'accepted' });
    await this.publish();
  }

  /**
   * Put the session back into the permission mode it was last given.
   *
   * A restart otherwise dropped it silently: the request file still said `accepted` while the
   * runtime came up in `default`, and the drop went the dangerous way — from a mode that asks
   * before writing to one that asks less. A session surviving a restart is this project's whole
   * promise, and a setting that decides what a turn may do to a working tree is part of the session.
   */
  private async restoreMode(): Promise<void> {
    const request = readRuntimeMode(this.m, this.session);
    if (!shouldRestoreMode(request, this.session.registrationGeneration) || request === null)
      return;
    try {
      await this.query?.setPermissionMode?.(request.mode);
      this.permissionMode = request.mode;
    } catch (error) {
      // Reported rather than assumed: publishing a mode the runtime refused would be worse than
      // coming up in the default one, because a reader would trust it.
      await this.report(error);
    }
  }

  /**
   * Move the session to the permission mode a caller asked for.
   *
   * Applied between turns only. Changing it mid-turn would move the boundary under a tool call that
   * was already judged against the old one — the approval a person gave would then be for a
   * different question than the one being answered.
   */
  private async applyMode(): Promise<void> {
    const request = readRuntimeMode(this.m, this.session);
    if (request === null || request.phase !== 'queued') return;
    if (request.generation !== this.session.registrationGeneration) return;
    if (this.turn.status === 'inProgress') return;
    try {
      await this.query?.setPermissionMode?.(request.mode);
    } catch (error) {
      await writeRuntimeMode(this.m, this.session, {
        ...request,
        phase: 'rejected',
        reason: 'The runtime refused this permission mode',
      });
      await this.report(error);
      return;
    }
    this.permissionMode = request.mode;
    await writeRuntimeMode(this.m, this.session, { ...request, phase: 'accepted', reason: null });
    await this.publish();
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
    this.turnId = nativeId;
    this.turnStartedAt = new Date().toISOString();
    this.turn = { ...this.turn, status: 'inProgress', state: 'working' };
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
    this.content?.buffer.resetContext();
    this.content?.publish();
    await this.content?.writer.flushPending();
  }

  /**
   * Put the files back, when a caller asked and the turn that touched them has ended.
   *
   * Between turns only, for the same reason the mode change is: restoring files under a running
   * turn changes the tree the turn is reasoning about, halfway through.
   */
  private async applyRewind(): Promise<void> {
    const request = readRuntimeRewind(this.m, this.session);
    if (request === null || request.phase !== 'queued') return;
    if (request.generation !== this.session.registrationGeneration) return;
    if (this.turn.status === 'inProgress') return;
    try {
      const result = (await this.query?.rewindFiles?.(request.messageId, {
        dryRun: request.dryRun,
      })) as
        | {
            canRewind?: boolean;
            error?: string;
            filesChanged?: string[];
            insertions?: number;
            deletions?: number;
            skippedLinks?: number;
          }
        | undefined;
      if (!result) throw new Error('The runtime returned no rewind result');
      await writeRuntimeRewind(this.m, this.session, {
        ...request,
        phase: 'complete',
        result: RewindResultSchema.parse({
          canRewind: result.canRewind === true,
          error: result.error ?? null,
          filesChanged: (result.filesChanged ?? []).slice(0, 512),
          insertions: result.insertions ?? null,
          deletions: result.deletions ?? null,
          // Absent means "no refusals happened", which is a different fact from "not measured" —
          // and only a real rewind can report it at all, so a preview leaves it null.
          skippedLinks: request.dryRun ? null : (result.skippedLinks ?? 0),
        }),
      });
    } catch (error) {
      await writeRuntimeRewind(this.m, this.session, {
        ...request,
        phase: 'failed',
        reason: 'The runtime could not rewind these files',
      });
      await this.report(error);
    }
  }

  async tick(): Promise<void> {
    await this.applyInterrupt();
    await this.applyMode();
    await this.applyRewind();
    await this.applyMcpRequest();
    await this.applyResponse();
    const input = readRuntimeInput(this.m, this.session);
    if (
      input &&
      input.phase === 'queued' &&
      input.nativeId !== this.dispatched &&
      // One turn at a time. Dispatching a second while the first runs retags its items, lets its
      // result close the wrong turn, and points an interrupt at a turn that is not running.
      this.turn.status !== 'inProgress'
    ) {
      this.dispatched = input.nativeId;
      this.turnId = input.nativeId;
      this.turnStartedAt = new Date().toISOString();
      this.turn = { ...this.turn, status: 'inProgress', state: 'working' };
      // `dispatching` before the queue, `accepted` after: a crash between the two is then visible as
      // an in-flight dispatch rather than as a delivered message that never arrived.
      await writeRuntimeInput(this.m, this.session, { ...input, phase: 'dispatching' });
      const options = input.turnOptions?.options;
      if (options?.runtime === 'claude') {
        // A turn's own model and effort, applied before it is queued so they govern this turn rather
        // than the one after it.
        if (options.model.model !== this.selection?.model.model)
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
    await this.publish();
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
        sequence: this.sequence,
        connected: this.connected,
        turn: this.turn,
        turnId: this.turnId,
        turnStartedAt: this.turnStartedAt,
        items: this.items,
        pending: [...this.pending.values()].map((entry) => entry.request),
        selection: this.selection,
        permissionMode: this.permissionMode,
        contextUsage: this.contextUsage,
        account: this.account,
        spend: this.spend,
        fileCheckpoints: this.session.fileCheckpoints === true,
        mcpServers: this.mcpServers,
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
    this.connected = false;
    try {
      // Bounded: shutdown must not hang inside the owner lock waiting on a runtime that is gone.
      await Promise.race([this.query?.interrupt?.() ?? Promise.resolve(), Bun.sleep(2_000)]);
    } catch {
      // Best effort at shutdown; the session is going away either way.
    }
    await this.publish().catch(() => undefined);
    await this.content?.close().catch(() => undefined);
  }
}

/** True when the runtime says the turn ended badly, rather than merely that it ended. */
function isFailureResult(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as { type?: unknown; is_error?: unknown; subtype?: unknown };
  if (record.type !== 'result') return record.type === 'model_refusal_no_fallback';
  return (
    record.is_error === true || (typeof record.subtype === 'string' && record.subtype !== 'success')
  );
}

interface ToolBlock {
  callId: string;
  name: string | null;
  lifecycle: 'running' | 'completed';
  failed: boolean;
  detail: string | null;
}

/**
 * Tool activity, from the two shapes that carry it.
 *
 * A tool CALL rides inside the finished assistant message as a `tool_use` block, and its RESULT
 * comes back with the user role as a `tool_result` block — there is no separate result message.
 * Reading only text blocks dropped both, so a conversation showed prose with unexplained gaps where
 * the agent had spent most of its time.
 */
function toolBlocks(message: unknown): ToolBlock[] {
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolBlock[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
      input?: unknown;
    };
    if (block.type === 'tool_use' && typeof block.id === 'string')
      out.push({
        callId: block.id,
        name: typeof block.name === 'string' ? block.name.slice(0, 128) : null,
        lifecycle: 'running',
        failed: false,
        detail: typeof block.name === 'string' ? summarise(block.name, block.input) : null,
      });
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      out.push({
        callId: block.tool_use_id,
        name: null,
        lifecycle: 'completed',
        failed: block.is_error === true,
        detail: null,
      });
  }
  return out;
}

/**
 * The text carried by one incremental stream event, if it carries any.
 *
 * Only `text_delta`. The stream also carries block starts and stops, message envelopes and pings;
 * treating any of them as content would append empty strings between every real fragment, and
 * treating a thinking delta as assistant text would put reasoning into the transcript as speech.
 */
function deltaText(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const record = event as { type?: unknown; delta?: unknown };
  if (record.type !== 'content_block_delta') return null;
  const delta = record.delta as { type?: unknown; text?: unknown } | undefined;
  if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return null;
  return delta.text.length > 0 ? delta.text : null;
}

/** A short, honest description of what the tool would do, for the operator deciding about it. */
function summarise(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return toolName;
  const record = input as Record<string, unknown>;
  const detail = ['command', 'file_path', 'path', 'url', 'pattern'].reduce<string | null>(
    (found, key) => found ?? (typeof record[key] === 'string' ? (record[key] as string) : null),
    null,
  );
  return detail === null ? toolName : `${toolName}: ${detail.slice(0, 400)}`;
}
