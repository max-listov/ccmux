import { managedPeer } from '../chat/identity.ts';
import type { MachineConfig, Session } from '../types.ts';
import {
  CONTENT_BASELINE_BYTES,
  CONTENT_EVENT_BYTES,
  CONTENT_ITEM_BYTES,
  CONTENT_MAX_ITEMS,
  CONTENT_MAX_RECORDS,
  CONTENT_REPLAY_BYTES,
  type ContentRecord,
  type ContentSnapshot,
} from './schema.ts';
import { textChunks, textTail } from './text.ts';
import type { ToolObservation } from './toolSchema.ts';

type Kind = ContentRecord['kind'];
const keyOf = (turnId: string | null, itemId: string) => JSON.stringify([turnId, itemId]);
const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const protectedItem = (item: ContentRecord) => item.kind === 'request' || item.kind === 'terminal';

/** The bounded buffer is an observation cache, never native conversation history. */
export class ContentBuffer {
  private value: ContentSnapshot;
  private states = new Map<string, ContentRecord>();
  private pendingSurrogates = new Map<string, string>();
  private positions = new Map<string, ContentRecord>();
  private replayBytes = 0;
  constructor(m: MachineConfig, session: Session, generation: string) {
    this.value = {
      protocol: 1,
      target: managedPeer(m.rcPrefix, session),
      registrationGeneration: session.registrationGeneration ?? null,
      nativeId: session.nativeSession?.id ?? session.uuid,
      generation,
      sequence: 0,
      droppedThrough: 0,
      contextBoundary: 0,
      omittedRecords: 0,
      status: 'live',
      records: [],
      baseline: [],
    };
  }
  snapshot(): ContentSnapshot {
    return structuredClone(this.value);
  }
  noteOmitted(records: number): void {
    this.value.omittedRecords += records;
  }
  unavailable(): void {
    this.value.status = 'unavailable';
  }
  resetContext(): void {
    this.value.contextBoundary = ++this.value.sequence;
    this.value.droppedThrough = this.value.sequence;
    this.value.omittedRecords += this.value.records.length;
    this.value.records = [];
    this.value.baseline = [];
    this.states.clear();
    this.pendingSurrogates.clear();
    this.positions.clear();
    this.replayBytes = 0;
  }
  text(
    kind: 'assistant' | 'reasoning-summary',
    turnId: string,
    itemId: string,
    input: string,
    operation: 'append' | 'replace',
    complete = false,
  ): void {
    const key = keyOf(turnId, itemId),
      prior = this.states.get(key) ?? this.positions.get(key);
    // A truncated baseline is not coverage-complete, but the native item is still terminal.
    if ((this.positions.get(key)?.complete || prior?.complete) && !complete) return;
    let text = input;
    if (operation === 'append') text = (this.pendingSurrogates.get(key) ?? '') + text;
    this.pendingSurrogates.delete(key);
    const last = text.charCodeAt(text.length - 1);
    if (!complete && last >= 0xd800 && last <= 0xdbff) {
      if (this.pendingSurrogates.size >= CONTENT_MAX_ITEMS)
        throw new Error('Native content partial-text window exceeded');
      this.pendingSurrogates.set(key, text.slice(-1));
      text = text.slice(0, -1);
    }
    if (
      operation === 'replace' &&
      prior?.text === text &&
      prior.complete === complete &&
      prior.omittedBytes === 0
    )
      return;
    if (!text.length && !complete && operation === 'append') return;
    const revision = operation === 'replace' ? (prior?.revision ?? 0) + 1 : (prior?.revision ?? 1);
    const prefixKnown = operation === 'replace' || prior?.prefixKnown === true;
    let offset = operation === 'append' ? (prior?.totalBytes ?? 0) : 0;
    const chunks = textChunks(text, CONTENT_EVENT_BYTES);
    if (!chunks.length) chunks.push('');
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      const total = offset + Buffer.byteLength(chunk);
      this.push({
        kind,
        turnId,
        itemId,
        operation: i === 0 ? operation : 'append',
        revision,
        offsetBytes: offset,
        prefixKnown,
        text: chunk,
        totalBytes: total,
        omittedBytes: 0,
        complete: complete && i === chunks.length - 1,
        status: null,
        tool: null,
      });
      offset = total;
    }
    const tail = textTail(
      operation === 'append' ? (prior?.text ?? '') + text : text,
      CONTENT_ITEM_BYTES,
    );
    const record = this.value.records.at(-1);
    if (record === undefined) return;
    this.states.delete(key);
    this.states.set(key, {
      ...record,
      operation: 'replace',
      text: tail.text,
      offsetBytes: offset - Buffer.byteLength(tail.text),
      totalBytes: offset,
      omittedBytes: offset - Buffer.byteLength(tail.text),
      complete: complete && prefixKnown && offset === Buffer.byteLength(tail.text),
    });
    this.rememberPosition({ ...record, complete });
    this.boundStates();
  }
  lifecycle(
    kind: Exclude<Kind, 'assistant' | 'reasoning-summary' | 'tool'>,
    turnId: string | null,
    itemId: string,
    status: string | null,
    text: string | null = null,
  ): void {
    const key = keyOf(turnId, itemId),
      previous = this.states.get(key);
    if (previous?.kind === kind && previous.status === status && previous.text === text) return;
    const record = this.push({
      kind,
      turnId,
      itemId,
      operation: 'lifecycle',
      revision: (previous?.revision ?? 0) + 1,
      offsetBytes: 0,
      prefixKnown: true,
      text,
      totalBytes: text === null ? 0 : Buffer.byteLength(text),
      omittedBytes: 0,
      complete: kind === 'terminal' || status === 'completed' || status === 'resolved',
      status,
      tool: null,
    });
    this.states.delete(key);
    this.states.set(key, record);
    this.boundStates();
  }
  tool(turnId: string, itemId: string, observation: ToolObservation): void {
    const key = keyOf(turnId, itemId);
    const previous = this.states.get(key) ?? this.positions.get(key);
    if (previous?.tool?.lifecycle === 'completed' && observation.lifecycle !== 'completed') return;
    if (
      previous?.tool?.callId != null &&
      observation.callId !== null &&
      previous.tool.callId !== observation.callId
    )
      throw new Error('Native tool item changed call identity');
    const tool: ToolObservation = {
      ...observation,
      callId: observation.callId ?? previous?.tool?.callId ?? null,
      name: observation.name ?? previous?.tool?.name ?? null,
      outcome:
        observation.outcome === 'unknown'
          ? (previous?.tool?.outcome ?? 'unknown')
          : observation.outcome,
      exitCode: observation.exitCode ?? previous?.tool?.exitCode ?? null,
    };
    if (previous?.tool && JSON.stringify(previous.tool) === JSON.stringify(tool)) return;
    const record = this.push({
      kind: 'tool',
      turnId,
      itemId,
      operation: 'lifecycle',
      revision: (previous?.revision ?? 0) + 1,
      offsetBytes: 0,
      prefixKnown: true,
      text: null,
      totalBytes: 0,
      omittedBytes: 0,
      complete: tool.lifecycle === 'completed',
      status: tool.lifecycle,
      tool,
    });
    this.states.delete(key);
    this.states.set(key, record);
    this.rememberPosition(record);
    this.boundStates();
  }
  private rememberPosition(record: ContentRecord): void {
    const key = keyOf(record.turnId, record.itemId);
    this.positions.delete(key);
    this.positions.set(key, { ...record, text: null });
    while (this.positions.size > 256) {
      const oldest = this.positions.keys().next().value;
      if (oldest === undefined) break;
      this.positions.delete(oldest);
    }
  }
  private push(input: Omit<ContentRecord, 'sequence' | 'at'>): ContentRecord {
    const record = { ...input, sequence: ++this.value.sequence, at: new Date().toISOString() };
    this.value.records.push(record);
    this.replayBytes += sizeOf(record) + 1;
    while (
      this.value.records.length > CONTENT_MAX_RECORDS ||
      this.replayBytes > CONTENT_REPLAY_BYTES
    ) {
      const removed = this.value.records.shift();
      if (removed) {
        this.replayBytes -= sizeOf(removed) + 1;
        this.value.droppedThrough = removed.sequence;
        this.value.omittedRecords++;
      }
    }
    return record;
  }
  private boundStates(): void {
    while (
      this.states.size > CONTENT_MAX_ITEMS ||
      sizeOf([...this.states.values()]) > CONTENT_BASELINE_BYTES
    ) {
      const candidate =
        [...this.states].find(([, item]) => !protectedItem(item)) ??
        this.states.entries().next().value;
      if (candidate === undefined) break;
      this.states.delete(candidate[0]);
      this.pendingSurrogates.delete(candidate[0]);
      this.value.omittedRecords++;
    }
    this.value.baseline = [...this.states.values()];
  }
}
