import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedHistoryPage, historyCursor } from '../../context/history.ts';
import type { NativeContextApi } from '../../context/pump.ts';
import type { NativeHistoryEntry } from '../../context/schema.ts';
import { refusals } from '../../control/schema/refusals.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../../types.ts';
import { clip, DEFAULT_TEXT_LIMIT, isRecord, num, str } from '../transcript/normalize.ts';
import { antigravityDataDir } from './preflight.ts';

/** Where Antigravity CLI writes a conversation's JSONL transcript under its data root. */
export function antigravityTranscriptPath(
  s: Pick<Session, 'nativeSession'>,
  m: Pick<MachineConfig, 'antigravityDataDir'>,
): string | null {
  const id = s.nativeSession?.id;
  if (!id) return null;
  return join(antigravityDataDir(m), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

function parseUsage(raw: Record<string, unknown>): TranscriptMessage['usage'] {
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cacheRead = num(raw.cache_read_tokens);
  if (input === null && output === null && cacheRead === null) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheCreationTokens: 0,
  };
}

function toolCallName(call: Record<string, unknown>): string {
  return str(call.name) ?? str(call.tool_name) ?? 'tool';
}

function toolCallId(call: Record<string, unknown>, fallback: string): string {
  return str(call.id) ?? str(call.tool_call_id) ?? fallback;
}

/**
 * Parse Antigravity CLI `transcript.jsonl` lines into Stitchmux's unified `TranscriptMessage[]`.
 *
 * Keeps line-based `seq` monotonic so cursor/before pagination never drops or duplicates entries.
 */
export function parseAntigravityTranscript(
  lines: string[],
  startLine: number,
  textLimit = DEFAULT_TEXT_LIMIT,
  endLine?: number,
  baseLine = 1,
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const lastLine = endLine ?? baseLine + lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = baseLine + i;
    if (lineNo < startLine || lineNo > lastLine) continue;
    const rawLine = lines[i]?.trim();
    if (!rawLine) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const type = str(entry.type);
    const createdAt = str(entry.created_at);
    const stepIndex = num(entry.step_index) ?? lineNo;
    const baseId = `agy-${stepIndex}`;
    const status = str(entry.status) === 'ERROR' ? 'error' : null;

    if (type === 'USER_INPUT') {
      const content = str(entry.content);
      if (content === null || content === '') continue;
      messages.push({
        id: baseId,
        seq: lineNo,
        createdAt,
        role: 'user',
        kind: 'message',
        text: clip(content, textLimit),
        title: null,
        toolName: null,
        toolCallId: null,
        status,
        rawType: type,
        done: true,
        result: null,
        input: null,
        resultText: null,
        image: null,
        usage: null,
        doneAt: null,
        agent: null,
      });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const thinking = str(entry.thinking);
      if (thinking && thinking.trim() !== '') {
        messages.push({
          id: `${baseId}:thinking`,
          seq: lineNo,
          createdAt,
          role: 'assistant',
          kind: 'thinking',
          text: clip(thinking, textLimit),
          title: null,
          toolName: null,
          toolCallId: null,
          status: null,
          rawType: type,
          done: true,
          result: null,
          input: null,
          resultText: null,
          image: null,
          usage: null,
          doneAt: null,
          agent: null,
        });
      }
      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      for (let t = 0; t < toolCalls.length; t++) {
        const call = toolCalls[t];
        if (!isRecord(call)) continue;
        const name = toolCallName(call);
        const callId = toolCallId(call, `${baseId}:tool:${t}`);
        const args = call.arguments ?? call.args ?? call.input;
        messages.push({
          id: callId,
          seq: lineNo,
          createdAt,
          role: 'tool',
          kind: 'tool_call',
          text: null,
          title: name,
          toolName: name,
          toolCallId: callId,
          status,
          rawType: type,
          done: true,
          result: status === 'error' ? 'error' : 'ok',
          input: args === undefined ? null : clip(JSON.stringify(args), textLimit),
          resultText: null,
          image: null,
          usage: null,
          doneAt: null,
          agent: null,
        });
      }
      const content = str(entry.content);
      if (content && content.trim() !== '') {
        messages.push({
          id: `${baseId}:text`,
          seq: lineNo,
          createdAt,
          role: 'assistant',
          kind: 'message',
          text: clip(content, textLimit),
          title: null,
          toolName: null,
          toolCallId: null,
          status,
          rawType: type,
          done: true,
          result: null,
          input: null,
          resultText: null,
          image: null,
          usage: parseUsage(entry),
          doneAt: null,
          agent: null,
        });
      }
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      const content = str(entry.content) ?? str(entry.message);
      if (!content) continue;
      messages.push({
        id: baseId,
        seq: lineNo,
        createdAt,
        role: 'system',
        kind: 'event',
        text: clip(content, textLimit),
        title: 'error',
        toolName: null,
        toolCallId: null,
        status: 'error',
        rawType: type,
        done: true,
        result: 'error',
        input: null,
        resultText: null,
        image: null,
        usage: null,
        doneAt: null,
        agent: null,
      });
    }
  }
  return messages;
}

function historyEntry(message: TranscriptMessage): NativeHistoryEntry {
  const kind: NativeHistoryEntry['kind'] =
    message.kind === 'thinking'
      ? 'reasoning-summary'
      : message.kind === 'tool_call' || message.kind === 'tool_result'
        ? 'tool'
        : message.role === 'user' || message.role === 'assistant'
          ? message.role
          : 'other';
  return {
    turnId: message.id,
    itemId: message.id,
    kind,
    text: message.text ?? null,
    omittedBytes: 0,
    images: [],
    omittedImages: 0,
    status: message.status === 'error' ? 'failed' : 'completed',
    tool:
      message.toolName === null
        ? null
        : {
            callId: message.toolCallId,
            name: message.toolName,
            lifecycle: 'completed',
            outcome: message.status === 'error' ? 'failed' : 'succeeded',
            exitCode: null,
          },
  };
}

const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isInteger(value) || value < 0)
    throw refusals.errors.HISTORY_CURSOR({ message: 'Native history cursor is invalid' });
  return value;
};

/** Context API for Antigravity native sessions backed by `brain/<id>/.../transcript.jsonl`. */
export function antigravityContextApi(m: MachineConfig, s: Session): NativeContextApi {
  const path = antigravityTranscriptPath(s, m);
  return {
    async history(query) {
      if (path === null || !existsSync(path)) return boundedHistoryPage(m, s, [], null, 'complete');
      const all = readFileSync(path, 'utf8').split('\n');
      const from = offsetOf(historyCursor(m, s, query.cursor));
      const entries: NativeHistoryEntry[] = [];
      let line = from;
      while (line < all.length && entries.length < query.limit) {
        for (const message of parseAntigravityTranscript(all, line + 1, undefined, line + 1))
          entries.push(historyEntry(message));
        line += 1;
      }
      const done = line >= all.length;
      return boundedHistoryPage(
        m,
        s,
        entries,
        done ? null : String(line),
        done ? 'complete' : 'more',
      );
    },
    async compactionMarker() {
      return null;
    },
    async compact() {
      throw refusals.errors.UNSUPPORTED({
        message: 'Antigravity runtime does not support manual compaction',
      });
    },
  };
}
