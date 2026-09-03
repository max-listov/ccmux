import type { ContentProducer } from '../../../content/producer.ts';
import { mergeRateLimitEvent } from '../../../runtime/planLimits.ts';
import type { NativeSnapshot, PermissionMode } from '../../../runtime/projectionSchema.ts';
import { deltaText, toolBlocks } from './content.ts';
import { initialTurn, type TurnState } from './turn.ts';
import { nativeUsage, type SdkModelUsage, turnDelta } from './usage.ts';

type RateLimitInfo = { rateLimitType?: string; utilization?: number; resetsAt?: number };

/** Bounded so a long session cannot grow the published observation without limit. */
const MAX_ITEMS = 256;

/**
 * Everything a session publishes about itself, and the only thing that changes it.
 *
 * Every native adapter keeps this in a projection object rather than on the connection holder, and
 * for the same reason: the state and the methods that advance it belong together. Split apart, the
 * methods become free functions over someone else's mutable fields, which is worse than either.
 *
 * `composeSnapshot` stays a pure function underneath this, which is one layer more than the
 * siblings have and is worth keeping: what the snapshot IS remains testable without a projection.
 */
export class NativeProjection {
  content: ContentProducer | null = null;
  items: NativeSnapshot['nativeItems'] = [];
  sequence = 0;
  connected = false;
  usageSoFar: Record<string, SdkModelUsage> = {};
  turn: TurnState = initialTurn;
  turnId: string | null = null;
  turnStartedAt: string | null = null;
  /** Item ids per turn, so a text stream coalesces instead of one item per fragment. */
  textItem = new Map<string, number>();
  /** What the runtime is actually using, published so a reader never has to guess. */
  selection: NativeSnapshot['nativeSelection'] = null;
  /**
   * The mode the next turn runs under. Held here because the runtime has no getter: what a session
   * publishes must be what it last successfully applied, not what someone hoped it applied.
   */
  permissionMode: PermissionMode = 'default';
  /** The last context measurement the runtime gave, refreshed when a turn ends rather than per tick. */
  contextUsage: NativeSnapshot['contextUsage'];
  /** Which account this session runs on, asked once — it does not change while a session lives. */
  account: NativeSnapshot['account'];
  /** How full the account's plan windows are, refreshed when a turn ends and on a limit event. */
  planLimits: NativeSnapshot['planLimits'];
  /** The session's MCP servers and their connection status, refreshed when one is acted on. */
  mcpServers: NativeSnapshot['mcpServers'];
  /** Cumulative spend, as the runtime reports it at the end of each turn. */
  spend: NativeSnapshot['spend'];

  /**
   * Keep what a `rate_limit_event` said instead of filing it as a diagnostic and losing it.
   *
   * The event is the only limit signal that arrives without being asked — including the `rejected`
   * status, which IS the refusal. It names one window, so it merges onto the read rather than
   * replacing every window with the single one the server mentioned.
   */
  takeRateLimit(message: { type: string }): void {
    if (message.type !== 'rate_limit_event') return;
    const info = (message as { rate_limit_info?: unknown }).rate_limit_info;
    if (info === null || typeof info !== 'object') return;
    this.planLimits = mergeRateLimitEvent(this.planLimits, info as RateLimitInfo, Date.now());
  }

  record(message: { type: string }, kind: string, failed: boolean): void {
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
        usage: null,
      });
      // Into the CONTENT stream, which is the surface consumers actually read — the numbers were
      // never missing here, they rode on the terminal item of a projection nobody scans for spend,
      // so a turn on this runtime read as free rather than unreported. Same record shape and same
      // item id as the other runtimes, with the accounting scope declared: this figure is one
      // turn's, differenced against the runtime's running total.
      const spent = this.takeUsage(message);
      if (spent !== null)
        this.content?.buffer.lifecycle(
          'usage',
          turnId,
          `${turnId}:usage`,
          'updated',
          JSON.stringify({ scope: 'run', ...spent }),
        );
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
  recordTool(message: { type: string }, turnId: string): void {
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

  appendItem(item: Omit<NativeSnapshot['nativeItems'][number], 'sequence' | 'at'>): number {
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
  takeSpend(message: unknown): void {
    const record = message as { type?: unknown; total_cost_usd?: unknown };
    if (record.type !== 'result' || typeof record.total_cost_usd !== 'number') return;
    if (!Number.isFinite(record.total_cost_usd) || record.total_cost_usd < 0) return;
    this.spend = {
      totalCostUsd: record.total_cost_usd,
      observedAt: new Date().toISOString(),
    };
  }

  /** Per-turn spend, differenced against the running total the runtime keeps for the session. */
  takeUsage(message: unknown): NativeSnapshot['nativeItems'][number]['usage'] {
    const record = message as { modelUsage?: Record<string, SdkModelUsage> };
    if (record.modelUsage === undefined) return nativeUsage({ reported: false });
    const delta = turnDelta(record.modelUsage, this.usageSoFar);
    this.usageSoFar = record.modelUsage;
    return nativeUsage({ reported: true, delta });
  }
}
