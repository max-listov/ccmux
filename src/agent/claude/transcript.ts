import { createHash } from 'node:crypto';
import type { TranscriptAgent, TranscriptImage, TranscriptUsage } from '../../config/schema.ts';
import type { TranscriptKind, TranscriptMessage, TranscriptRole } from '../../types.ts';
import { clip, DEFAULT_TEXT_LIMIT, flattenContent, num, rec, str } from '../normalize.ts';
import { resultSummary } from '../toolSummary.ts';
import { readSubagentFacts, subagentFile } from './subagent.ts';

// Claude Code transcript parser. Entry shape (one per JSONL line):
//   { type:"assistant"|"user"|…, message:{ role, content:[…], usage }, uuid, timestamp, … }
// content items are inline: { type:"text"|"thinking"|"tool_use" } and tool_result (user side).

/** content is an array of items, a bare string (→ single text item), or absent. */
function contentItems(entry: Record<string, unknown>): unknown[] {
  const content = rec(entry.message)?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function kindFor(item: Record<string, unknown>): TranscriptKind {
  switch (str(item.type) ?? '') {
    case 'text':
      return 'message';
    case 'tool_use':
      return 'tool_call';
    case 'tool_result':
      return 'tool_result';
    case 'thinking':
      return 'thinking';
    case 'image':
      return 'image';
    case '':
      return 'unknown';
    default:
      return 'event';
  }
}

function roleFor(entry: Record<string, unknown>, item: Record<string, unknown>): TranscriptRole {
  if (str(item.type) === 'tool_result') return 'tool';
  const role = str(rec(entry.message)?.role) ?? str(entry.type);
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  return 'unknown';
}

function textFor(item: Record<string, unknown>): string {
  switch (str(item.type) ?? '') {
    case 'text':
      return str(item.text) ?? '';
    case 'tool_use': {
      const input = rec(item.input);
      const q0 = Array.isArray(input?.questions) ? rec(input.questions[0]) : null;
      return (
        str(input?.description) ??
        str(input?.command) ??
        str(input?.file_path) ??
        str(input?.pattern) ??
        str(input?.query) ??
        str(input?.url) ??
        str(input?.prompt) ??
        str(q0?.question) ??
        flattenContent(input) ??
        str(item.name) ??
        ''
      );
    }
    case 'tool_result':
      return flattenContent(item.content) ?? '';
    case 'thinking':
      return str(item.thinking) ?? '';
    case 'image':
      // No word here on purpose. `[image]` was a picture replaced by a string nothing could turn
      // back into one; the picture is now addressed on the message instead.
      return '';
    default:
      return flattenContent(item) ?? '';
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Describe an image block without carrying it.
 *
 * The address is the entry's uuid and the block's position, which is stable for as long as the line
 * that holds it — the transcript is append-only, so a line never moves. An image that cannot be
 * fetched says which way it failed, because "unreadable" and "there was no image" call for
 * different reactions from whoever is reading.
 */
export function imageDescriptor(
  item: Record<string, unknown>,
  entryUuid: string,
  index: number,
): TranscriptImage {
  const address = `${entryUuid}#${index}`;
  const source = rec(item.source);
  const mediaType = str(source?.media_type) ?? null;
  if (str(source?.type) !== 'base64')
    // A URL source is somebody else's to fetch, and pretending otherwise would hand a reader an
    // address this project cannot answer.
    return { address, mediaType, bytes: null, digest: null, unavailable: 'unsupported-source' };
  const data = str(source?.data);
  if (!data) return { address, mediaType, bytes: null, digest: null, unavailable: 'malformed' };
  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES)
    return { address, mediaType, bytes, digest: null, unavailable: 'too-large' };
  return {
    address,
    mediaType,
    bytes,
    digest: createHash('sha256').update(data).digest('hex'),
    unavailable: null,
  };
}

/**
 * The bytes behind an address, read from the same lines the message came from.
 *
 * Kept out of the message so a listing stays cheap: `lastMessage` in `list --json` is read
 * constantly, and nobody asked it for pictures.
 */
export function readImage(
  lines: string[],
  address: string,
): { mediaType: string | null; data: string } | { unavailable: TranscriptImage['unavailable'] } {
  const [uuid, position] = address.split('#');
  const index = Number.parseInt(position ?? '', 10);
  if (!uuid || !Number.isInteger(index) || index < 0) return { unavailable: 'malformed' };
  for (const raw of lines) {
    if (!raw?.includes(uuid)) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!entry || str(entry.uuid) !== uuid) continue;
    const item = rec(contentItems(entry)[index]);
    const source = rec(item?.source);
    if (str(item?.type) !== 'image') return { unavailable: 'malformed' };
    if (str(source?.type) !== 'base64') return { unavailable: 'unsupported-source' };
    const data = str(source?.data);
    if (!data) return { unavailable: 'malformed' };
    return { mediaType: str(source?.media_type) ?? null, data };
  }
  return { unavailable: 'malformed' };
}

/** What the source said this answer cost. Absent fields stay null: unknown is not zero. */
export function usageOf(entry: Record<string, unknown>): TranscriptUsage | null {
  const usage = rec(rec(entry.message)?.usage);
  if (!usage) return null;
  const value = (key: string): number | null =>
    typeof usage[key] === 'number' ? Math.max(0, Math.trunc(usage[key] as number)) : null;
  return {
    inputTokens: value('input_tokens'),
    outputTokens: value('output_tokens'),
    cacheReadTokens: value('cache_read_input_tokens'),
    cacheCreationTokens: value('cache_creation_input_tokens'),
  };
}

// Raw bits a tool_result carries, kept aside by call-id so the fold can summarize it against
// its originating tool_call's input (full content, before any display clip).
interface RawResult {
  content: string;
  isError: boolean;
  /** When the result line was written: the call's end. */
  at: string | null;
}

/**
 * What the runtime said when an `Agent` call returned: the entry's `toolUseResult` names the agent
 * it spawned. `async_launched` means the result above it is only a receipt — the agent is still
 * working — and the call's real outcome arrives minutes later as a task notification.
 */
interface Spawn {
  agentId: string;
  status: string | null;
  model: string | null;
  description: string | null;
}

/** A `<task-notification>` the runtime injected as a user message when a spawned agent stopped. */
interface Notification {
  at: string | null;
  status: string | null;
  result: string | null;
}

const NOTIFICATION = /^\s*<task-notification>/;

function tagged(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim() ?? null;
}

/** The notification's fields when this user text is one; null for any other text. */
function notificationOf(text: string): { toolUseId: string; notification: Notification } | null {
  if (!NOTIFICATION.test(text)) return null;
  const toolUseId = tagged(text, 'tool-use-id');
  if (!toolUseId) return null;
  return {
    toolUseId,
    notification: { at: null, status: tagged(text, 'status'), result: tagged(text, 'result') },
  };
}

function spawnOf(entry: Record<string, unknown>): Spawn | null {
  const result = rec(entry.toolUseResult);
  const agentId = str(result?.agentId);
  if (!result || !agentId) return null;
  return {
    agentId,
    status: str(result.status),
    model: str(result.resolvedModel),
    description: str(result.description),
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

export function parse(
  lines: string[],
  startLine: number,
  textLimit: number = DEFAULT_TEXT_LIMIT,
  endLine?: number,
  baseLine = 1,
  source?: { path: string },
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const callInput = new Map<string, Record<string, unknown> | null>(); // call-id → tool_use input
  const callName = new Map<string, string>(); // call-id → tool name
  const results = new Map<string, RawResult>(); // call-id → raw tool_result
  const spawns = new Map<string, Spawn>(); // call-id → the agent that call spawned
  const notifications = new Map<string, Notification>(); // call-id → how its agent stopped
  // `lines[0]` is absolute line `baseLine`: the window may be a slice of the file rather than all
  // of it, and `seq` is a CURSOR — `transcript --cursor` hands it back and expects the same line.
  const lastLine = baseLine + lines.length - 1;
  const end = endLine !== undefined ? Math.min(lastLine, endLine) : lastLine;
  for (let line = Math.max(baseLine, startLine); line <= end; line++) {
    const i = line - baseLine;
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    const seq = line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entry = rec(parsed);
    if (!entry) continue;
    const entryUuid = str(entry.uuid) ?? String(seq);
    const createdAt = str(entry.timestamp);
    const spawn = spawnOf(entry);
    contentItems(entry).forEach((itemRaw, key) => {
      const item = rec(itemRaw);
      if (!item) return;
      const kind = kindFor(item);
      const text0 = textFor(item);
      const text = text0 === '' ? null : clip(text0, textLimit);
      let callId = str(item.id) ?? str(item.tool_use_id);
      const rawInput = rec(item.input);
      if (kind === 'tool_call' && callId) {
        callInput.set(callId, rawInput);
        callName.set(callId, str(item.name) ?? 'tool');
      }
      if (kind === 'tool_result' && callId) {
        results.set(callId, {
          content: flattenContent(item.content) ?? '',
          isError: item.is_error === true,
          at: createdAt,
        });
        if (spawn) spawns.set(callId, spawn);
      }
      // The runtime's word that a spawned agent stopped is a user message only in shape. It is
      // read from the FULL text, before the clip: a report inside it runs past any display limit,
      // and the call it answers is named in its first lines. The message keeps the call's id so a
      // consumer can join the two without parsing the tags itself.
      let title: string | null = null;
      if (kind === 'message' && roleFor(entry, item) === 'user') {
        const notified = notificationOf(text0);
        if (notified) {
          callId = notified.toolUseId;
          title = 'task-notification';
          notifications.set(callId, { ...notified.notification, at: createdAt });
        }
      }
      if (!(kind === 'tool_call' || kind === 'image' || (text !== null && text !== ''))) return;
      out.push({
        id: `${entryUuid}:${key}`,
        seq,
        createdAt,
        role: roleFor(entry, item),
        kind,
        text,
        title:
          kind === 'tool_call'
            ? (str(item.name) ?? 'tool')
            : kind === 'tool_result'
              ? 'tool result'
              : title,
        toolName: kind === 'tool_call' ? str(item.name) : null,
        toolCallId: callId,
        status: item.is_error === true ? 'error' : null,
        rawType: str(item.type) ?? str(entry.type),
        done: false,
        result: null,
        // Full tool input (the actual command/args) for the expanded card; result output is
        // filled in by foldResults once its tool_result arrives.
        input:
          kind === 'tool_call' && rawInput
            ? clip(JSON.stringify(rawInput, null, 2), textLimit)
            : null,
        resultText: null,
        image: kind === 'image' ? imageDescriptor(item, entryUuid, key) : null,
        // Carried on the message rather than only counted for the context window: the numbers were
        // read and thrown away in the same breath, so nobody could say what a turn cost.
        usage: roleFor(entry, item) === 'assistant' ? usageOf(entry) : null,
        doneAt: null,
        agent: null,
      });
    });
  }
  return foldResults(out, callInput, callName, results, textLimit, {
    spawns,
    notifications,
    source,
  });
}

/**
 * The agent an `Agent` call spawned, as the call should carry it.
 *
 * Its state is decided by two witnesses, the stronger first: the session's task notification,
 * which names the call and says how the agent stopped; failing that (the notification is outside
 * this window, or has not come yet), the agent's own transcript, which ends on the agent's answer
 * once it has stopped talking. A launch receipt alone proves nothing about the end.
 */
function spawnedAgent(
  spawn: Spawn,
  input: Record<string, unknown> | null,
  notification: Notification | undefined,
  source: { path: string } | undefined,
): { agent: TranscriptAgent; report: string | null } {
  const path = source ? subagentFile(source.path, spawn.agentId) : null;
  const facts = path ? readSubagentFacts(path) : null;
  const finished = notification !== undefined || facts?.idle === true;
  return {
    agent: {
      id: spawn.agentId,
      type: str(input?.subagent_type),
      description: spawn.description ?? str(input?.description),
      model: facts?.model ?? spawn.model,
      state: finished ? 'finished' : 'running',
      startedAt: facts?.startedAt ?? null,
      finishedAt: finished ? (notification?.at ?? facts?.lastAt ?? null) : null,
      toolCalls: facts?.toolCalls ?? null,
      usage: facts?.usage ?? null,
      available: facts !== null,
    },
    report: finished ? (notification?.result ?? facts?.lastText ?? null) : null,
  };
}

/** Merge each tool_result into the tool_call it answers: set `done`/`status`/`result` on the
 *  call and DROP the now-redundant standalone result. A result whose call isn't in this window
 *  is left as-is (rare; keeps the data). The card UI then renders one request→outcome block. */
function foldResults(
  msgs: TranscriptMessage[],
  callInput: Map<string, Record<string, unknown> | null>,
  callName: Map<string, string>,
  results: Map<string, RawResult>,
  textLimit: number,
  agents: {
    spawns: Map<string, Spawn>;
    notifications: Map<string, Notification>;
    source: { path: string } | undefined;
  },
): TranscriptMessage[] {
  const folded = new Set<string>(); // call-ids whose result got absorbed
  for (const m of msgs) {
    if (m.kind !== 'tool_call' || !m.toolCallId) continue;
    const r = results.get(m.toolCallId);
    if (!r) continue; // still running → stays pending (done:false)
    const input = callInput.get(m.toolCallId) ?? null;
    folded.add(m.toolCallId);
    const spawn = agents.spawns.get(m.toolCallId);
    if (spawn) {
      const notification = agents.notifications.get(m.toolCallId);
      const { agent, report } = spawnedAgent(spawn, input, notification, agents.source);
      m.agent = agent;
      // An asynchronous launch receipt is not the call's outcome: the call stays open as long as
      // the agent works, and closes on the agent's report — or on the receipt, when the runtime
      // ran the agent to completion inside the call.
      const async = spawn.status === 'async_launched';
      if (async && agent.state === 'running') {
        m.done = false;
        m.result = null;
        m.resultText = null;
        continue;
      }
      const stopped = notification?.status ?? null;
      m.done = true;
      m.doneAt = async ? agent.finishedAt : r.at;
      m.status = r.isError || (stopped !== null && stopped !== 'completed') ? 'error' : null;
      m.result =
        agent.toolCalls === null ? (stopped ?? 'finished') : plural(agent.toolCalls, 'tool call');
      m.resultText = clip(async ? (report ?? r.content) : r.content, textLimit);
      continue;
    }
    m.done = true;
    m.doneAt = r.at;
    m.status = r.isError ? 'error' : null;
    m.result = resultSummary(
      callName.get(m.toolCallId) ?? m.toolName ?? 'tool',
      input,
      r.content,
      r.isError,
    );
    m.resultText = clip(r.content, textLimit); // full output for the expanded card
  }
  return msgs.filter(
    (m) => !(m.kind === 'tool_result' && m.toolCallId !== null && folded.has(m.toolCallId)),
  );
}

/** The conversation's CURRENT model — the most-recent real assistant turn's `message.model`, read
 *  from jsonl (source of truth), not the statusline. Skips `<synthetic>` turns (API-error / interrupt
 *  placeholders carry no real model) and only trusts `role:"assistant"` lines — image-gen model ids
 *  (`nano-banana-2`, `gpt-image-2`) live inside tool payloads, never in a real turn's message.model. */
export function lastModel(lines: string[]): string | null {
  const floor = Math.max(0, lines.length - 400);
  for (let i = lines.length - 1; i >= floor; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const msg = rec(rec(JSON.parse(line))?.message);
      if (msg?.role !== 'assistant') continue;
      const model = str(msg.model);
      if (model && model !== '<synthetic>') return model;
    } catch {
      // skip malformed line
    }
  }
  return null;
}

/** Context tokens used — the most recent assistant message's usage (input + cache). */
export function usedTokens(lines: string[]): number | null {
  const floor = Math.max(0, lines.length - 400);
  for (let i = lines.length - 1; i >= floor; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = rec(JSON.parse(line));
      const msg = rec(entry?.message);
      if (msg?.role !== 'assistant') continue;
      const u = rec(msg.usage);
      if (u)
        return (
          num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
        );
    } catch {
      // skip malformed line
    }
  }
  return null;
}
