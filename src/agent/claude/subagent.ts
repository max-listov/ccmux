import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { TranscriptUsage } from '../../config/schema.ts';
import { indexedUsage } from '../../usage/indexed.ts';
import { MtimeCache } from '../../util/mtimeCache.ts';
import { rec, str } from '../normalize.ts';
import { indexTranscript } from '../transcriptIndex.ts';
import { countStats } from '../transcriptRead.ts';
import { parse } from './transcript.ts';

// What a Claude subagent left behind, read from its own transcript.
//
// A session that spawns an agent gets back "Async agent launched successfully" within a second and
// then hears nothing for minutes; the agent's real story — every tool call, every request's usage,
// its final answer — is written to `<session-uuid>/subagents/agent-<id>.jsonl` beside the session
// file. This module reads that file into a handful of facts the transcript can carry on the `Agent`
// call, so a consumer sees the call live as long as the agent does and closes with its result.
//
// Cached by the file's mtime: the facts are asked for on every window read that contains the call,
// and a finished agent's file never changes again.

/** The folder Claude keeps a session's spawned agents in — named by the session file's uuid. */
export function subagentsDir(historyPath: string): string {
  return join(dirname(historyPath), basename(historyPath, '.jsonl'), 'subagents');
}

const AGENT_ID = /^[0-9a-f]{1,64}$/;

/** The transcript of one spawned agent, or null when the id is not one Claude would have issued. */
export function subagentFile(historyPath: string, agentId: string): string | null {
  return AGENT_ID.test(agentId) ? join(subagentsDir(historyPath), `agent-${agentId}.jsonl`) : null;
}

export interface SubagentFacts {
  startedAt: string | null;
  /** Timestamp of the last line written. Only a finish time once `idle` is true. */
  lastAt: string | null;
  /** The last line is the agent's own text with no tool call after it: it has stopped talking. */
  idle: boolean;
  toolCalls: number;
  usage: TranscriptUsage;
  /** The newest text block the agent wrote — its report once it has stopped. */
  lastText: string | null;
  model: string | null;
}

const EMPTY_USAGE: TranscriptUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
};

function compute(path: string, lines: string[]): SubagentFacts {
  const facts: SubagentFacts = {
    startedAt: null,
    lastAt: null,
    idle: false,
    toolCalls: 0,
    usage: { ...EMPTY_USAGE },
    lastText: null,
    model: null,
  };
  for (const raw of lines) {
    if (!raw || raw.trim() === '') continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!entry) continue;
    const at = str(entry.timestamp);
    if (at !== null) {
      facts.startedAt ??= at;
      facts.lastAt = at;
    }
    const message = rec(entry.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const blocks = content.map((block) => rec(block)).filter((block) => block !== null);
    const assistant = message?.role === 'assistant';
    if (assistant) {
      const model = str(message?.model);
      if (model && model !== '<synthetic>') facts.model = model;
      for (const block of blocks) {
        if (str(block.type) === 'tool_use') facts.toolCalls++;
        if (str(block.type) === 'text') {
          const text = str(block.text);
          if (text && text.trim() !== '') facts.lastText = text;
        }
      }
    }
    // Idle is a property of the LAST line: an answer with no tool call after it. A later tool_use
    // or tool_result line flips it back to working.
    facts.idle =
      assistant && blocks.length > 0 && blocks.every((block) => str(block.type) === 'text');
  }
  indexTranscript(path, 'claude', (batch) => countStats({ id: 'claude', parse }, batch));
  const usage = indexedUsage(path)?.values;
  if (usage)
    facts.usage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    };
  return facts;
}

const cache = new MtimeCache<SubagentFacts>(2 * 1024 * 1024, 128);

/** Facts about one spawned agent, or null when its transcript does not exist (yet, or any more). */
export function readSubagentFacts(path: string): SubagentFacts | null {
  if (!existsSync(path)) return null;
  return cache.get(path, () => compute(path, readFileSync(path, 'utf8').split('\n')));
}
