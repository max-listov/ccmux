import { rec } from './normalize.ts';

/**
 * The JSON records in a window of transcript lines, each with the absolute line it came from.
 *
 * `lines[0]` is absolute line `baseLine`: the window may be a slice of the file rather than all of
 * it, and the line number is a CURSOR — `transcript --cursor` hands it back and expects the same
 * line. Blank lines, lines that are not JSON and JSON that is not an object are skipped: a record
 * still being written is not a record yet.
 */
export function* transcriptEntries(
  lines: string[],
  startLine: number,
  endLine: number | undefined,
  baseLine: number,
): Generator<{ seq: number; entry: Record<string, unknown> }> {
  const lastLine = baseLine + lines.length - 1;
  const end = endLine !== undefined ? Math.min(lastLine, endLine) : lastLine;
  for (let line = Math.max(baseLine, startLine); line <= end; line++) {
    const raw = lines[line - baseLine];
    if (!raw || raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entry = rec(parsed);
    if (entry) yield { seq: line, entry };
  }
}
