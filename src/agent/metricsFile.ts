import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { STATUS_DIR } from '../config/paths.ts';
import { atomicWrite } from '../util/atomic.ts';

/**
 * The status-line metrics file, and nothing else in the module graph.
 *
 * This is the hottest path this tool has: Claude Code runs `statusLine` on every transcript event,
 * per session — measured at 29 renders a minute across seven sessions. What the command does is
 * write six numbers; what it COST was 135 ms of CPU a call, and only 55 ms of that was parsing the
 * bundle. The rest was evaluating the module graph it reached for those six numbers: `zod` alone
 * costs ~39 ms to evaluate, and `sessionStatus.ts` — which imports zod, the agent barrel, chat
 * types and launch stamps — costs ~97 ms before a single line runs.
 *
 * So the file's reader and writer live here, in a leaf that imports two functions from `node:fs`
 * and one path. Validation is by hand for the same reason: a schema library on this path is a
 * dependency evaluated thirty times a minute to check six fields. `sessionStatus.ts` re-exports
 * these under the same names — one implementation, one format, one place that knows the shape.
 */

export interface MetricsStatus {
  ts: number;
  /** context_window.used_percentage */
  pct: number | null;
  /** context_window.context_window_size */
  contextSizeTokens: number | null;
  /** model.display_name */
  model: string | null;
  costUsd: number | null;
  /** How often the agent asks for this line, counted where it is already writing. */
  renders: number;
  /** Start of the window `renders` covers, rolled forward so the rate describes recent behaviour. */
  rendersSince: number;
}

const safe = (name: string): string => name.replace(/[^\w.-]/g, '_');
export const metricsPath = (name: string): string => `${STATUS_DIR}/${safe(name)}.metrics.json`;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Read the record, or null when there is not one this reader can trust.
 *
 * The two counters are defaulted rather than required: records written before they existed carry
 * neither, and a missing count must read as "not measured yet" rather than as zero renders.
 */
export function readMetricsFile(name: string): MetricsStatus | null {
  const path = metricsPath(name);
  try {
    if (!existsSync(path)) return null;
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.ts !== 'number' || !Number.isFinite(row.ts)) return null;
    return {
      ts: row.ts,
      pct: numberOrNull(row.pct),
      contextSizeTokens: numberOrNull(row.contextSizeTokens),
      model: typeof row.model === 'string' ? row.model : null,
      costUsd: numberOrNull(row.costUsd),
      renders: numberOrNull(row.renders) ?? 0,
      rendersSince: numberOrNull(row.rendersSince) ?? 0,
    };
  } catch {
    return null;
  }
}

export async function writeMetricsFile(name: string, data: MetricsStatus): Promise<void> {
  mkdirSync(STATUS_DIR, { recursive: true });
  await atomicWrite(metricsPath(name), JSON.stringify(data));
}
