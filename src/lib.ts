/**
 * Public library entry — the STABLE seam for an external consumer of ccmux's session reader
 * (e.g. a tool that indexes `~/.claude` history for semantic recall). This file is the contract;
 * everything under `src/agent/**` stays free to refactor behind it.
 *
 * Deliberately lean: it wires only the PURE block-parsers + `readLines` + the shared types, so
 * importing it pulls in `zod` (for the type schemas) and `node:fs` — NOT ink/react/tmux or the
 * launch/pane machinery of the full agent providers. A consumer gets the tested, agent-agnostic
 * (Claude + Codex) transcript parser and nothing else.
 *
 * Consumed via a local `file:` link (Bun runs the TS directly); see `package.json` → `exports`
 * (`ccmux/session-reader`). No build/publish step — this is not shipped to the fleet (the fleet
 * gets the bundle built from `cli.ts`).
 */
import { parse as parseClaude } from './agent/claude/transcript.ts';
import { parse as parseCodex } from './agent/codex/transcript.ts';
import type { AgentKind, TranscriptMessage } from './types.ts';
import { readLines } from './util/readLines.ts';

/** Sniff the agent format from a session's lines — for indexing historical/dead files whose agent
 *  isn't known up front. Returns "claude" | "codex" | null. */
export { detect } from './agent/detect.ts';
export { DEFAULT_TEXT_LIMIT } from './agent/normalize.ts';
// ── Public types + helpers ───────────────────────────────────────────────────
export type { AgentKind, TranscriptKind, TranscriptMessage, TranscriptRole } from './types.ts';
export { readLines } from './util/readLines.ts';

const PARSERS: Partial<Record<AgentKind, typeof parseClaude>> = {
  claude: parseClaude,
  codex: parseCodex,
};

/**
 * Block-parse already-read JSONL lines into normalized messages (text/thinking/tool_call/
 * tool_result, call↔result stitched, image-safe, zero-cast). `textLimit` bounds each message's
 * text (default 6000 via the parser); pass a larger value (e.g. 10000) for full-text indexing.
 */
export function parseSession(
  lines: string[],
  agent: AgentKind,
  textLimit?: number,
): TranscriptMessage[] {
  const parser = PARSERS[agent];
  if (parser === undefined)
    throw new Error('This runtime uses the structured native feed, not JSONL history');
  return parser(lines, 1, textLimit);
}

/**
 * Convenience: read a session JSONL file from disk and block-parse it in one call —
 * `parseSession(readLines(path), agent, textLimit)`. This is the common entry for an external
 * indexer that has a path + a known agent.
 */
export function readSession(
  path: string,
  agent: AgentKind,
  textLimit?: number,
): TranscriptMessage[] {
  return parseSession(readLines(path), agent, textLimit);
}
