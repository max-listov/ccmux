import type { AgentKind } from '../types.ts';
import { rec, str } from './normalize.ts';

/**
 * Best-effort agent-format sniff from the first non-empty JSONL line — a fallback for a session
 * file whose agent isn't otherwise known (legacy rows, or an external consumer indexing historical
 * files on disk). Pure: lines → "claude" | "codex" | null. Kept in its own light module (only
 * `normalize` deps) so the public library seam can re-export it without dragging in the full agent
 * providers (ink/tmux/launch).
 */
export function detect(lines: string[]): AgentKind | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    let entry: Record<string, unknown> | null = null;
    try {
      entry = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const type = str(entry.type);
    if (type === 'response_item' || type === 'session_meta' || type === 'event_msg') return 'codex';
    if (entry.message !== undefined || entry.sessionId !== undefined) return 'claude';
    return null;
  }
  return null;
}
