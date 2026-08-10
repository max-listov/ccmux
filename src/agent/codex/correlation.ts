import { existsSync } from "node:fs";
import { Glob } from "bun";
import { z } from "zod";
import type { MachineConfig } from "../../types.ts";
import { readFirstLine, readHeadLines, readTailLines } from "../../util/readLines.ts";

const SessionMetaEnvelopeSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.uuid(),
    originator: z.string(),
    forked_from_id: z.uuid().nullable().optional(),
  }),
});

const UserMessageEnvelopeSchema = z.object({
  type: z.literal("response_item"),
  payload: z.object({
    type: z.literal("message"),
    role: z.literal("user"),
    content: z.array(z.object({ type: z.literal("input_text"), text: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();

function hasExactForkMarker(path: string, marker: string): boolean {
  const expected = `ccmux launch correlation: ${marker}`;
  // Native fork copies the source's full initial history before appending this launch turn. The
  // unique marker is therefore near the live tail, not at any fixed head byte/record offset.
  for (const line of readTailLines(path, 256)) {
    try {
      const parsed = UserMessageEnvelopeSchema.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.payload.content.some((item) => item.text.includes(expected))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Exact rollout correlation. cwd/mtime/source are display metadata and never selectors. */
export function rolloutIdsForMarker(m: MachineConfig, marker: string): string[] {
  const root = m.codexSessionsDir;
  if (!root || !existsSync(root)) return [];
  const ids: string[] = [];
  const markerField = `"originator":${JSON.stringify(marker)}`;
  for (const path of new Glob("**/rollout-*.jsonl").scanSync({ cwd: root, absolute: true })) {
    // Codex 0.147 session_meta may carry a large base_instructions value on the same first line.
    // originator is serialized before that payload: reject non-matches from a cheap head slice,
    // then parse the one complete matching JSON record through Zod.
    if (!readHeadLines(path, 64 * 1024).join("\n").includes(markerField)) continue;
    const first = readFirstLine(path);
    if (!first) continue;
    try {
      const parsed = SessionMetaEnvelopeSchema.parse(JSON.parse(first));
      if (parsed.payload.originator === marker) ids.push(parsed.payload.id);
    } catch {
      continue;
    }
  }
  return ids;
}

/** A native `codex fork` ignores the originator override used by fresh launches. Correlate its
 * explicit first-turn marker plus Codex's provider-recorded parent. A copied/renamed rollout can
 * never satisfy both sides. */
export function forkRolloutIdsForMarker(m: MachineConfig, marker: string, sourceThreadId: string): string[] {
  const root = m.codexSessionsDir;
  if (!root || !existsSync(root)) return [];
  const ids: string[] = [];
  for (const path of new Glob("**/rollout-*.jsonl").scanSync({ cwd: root, absolute: true })) {
    const first = readFirstLine(path);
    if (!first) continue;
    try {
      const parsed = SessionMetaEnvelopeSchema.parse(JSON.parse(first));
      if (parsed.payload.forked_from_id !== sourceThreadId) continue;
      if (hasExactForkMarker(path, marker)) {
        ids.push(parsed.payload.id);
      }
    } catch {
      continue;
    }
  }
  return ids;
}
