import { existsSync, readFileSync } from 'node:fs';
import { type MetricsStatus, readMetricsFile, writeMetricsFile } from '../agent/metricsFile.ts';

/**
 * `ccmux status-line` — the injected Claude Code statusLine command for a managed session. Claude
 * feeds statusLine a STRUCTURED JSON on stdin (model, context_window.used_percentage/size, cost). We
 * TEE it: capture those metrics into the session's metrics file (so `list`/TUI read context% from
 * Claude's own numbers, no regex over rendered text, no dependency on the user's statusline FORMAT),
 * then run the user's ORIGINAL statusline with the SAME stdin so their visual bar is unchanged.
 *
 * Identity is `CCMUX_SESSION`. Fully fail-open: any error still tries to render the original (or
 * prints nothing) so the statusline never breaks. Kept dependency-light on purpose — this runs on
 * every statusline refresh (debounced, but hotter than end-of-turn hooks).
 */

/**
 * Read by hand, because a schema library on this path is evaluated thirty times a minute.
 *
 * `zod` costs about as much to evaluate as everything else this command does, and it is used here
 * for two shapes of a handful of optional fields — each read once, each already guarded by a
 * try/catch and a null return. Hand reading is the cheaper instrument for the same certainty; the
 * declared contracts elsewhere in this tree are not affected, and nothing else on this path
 * validates these two files.
 */
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Pure: statusLine stdin JSON → the metrics to persist, or null on bad JSON. Separated for tests. */
export function extractMetrics(raw: string, now: number): MetricsStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const j = asObject(parsed);
  if (j === undefined) return null;
  const cw = asObject(j.context_window);
  const model = asObject(j.model);
  const cost = asObject(j.cost);
  return {
    ts: now,
    pct: asNumber(cw?.used_percentage),
    contextSizeTokens: asNumber(cw?.context_window_size),
    model: asString(model?.display_name) ?? asString(model?.id) ?? null,
    costUsd: asNumber(cost?.total_cost_usd),
    renders: 1,
    rendersSince: now,
  };
}

/** How long a render count describes. Rolled forward at this age so the rate answers "how often is
 *  this happening now" — a session alive for two days would otherwise average its bursts away. */
export const RENDER_WINDOW_MS = 5 * 60_000;

/**
 * Carry the render count forward, starting a new window when the old one is stale.
 *
 * Pure, and separate from the write, because the number it produces is the one `status` reports as
 * a rate: a counter that quietly restarted, or one that never rolled and so reports a two-day
 * average as "now", is a wrong quantity that looks exactly like a right one.
 */
export function countRender(previous: MetricsStatus | null, next: MetricsStatus): MetricsStatus {
  if (
    previous === null ||
    previous.renders < 1 ||
    next.ts - previous.rendersSince > RENDER_WINDOW_MS
  )
    return { ...next, renders: 1, rendersSince: previous?.ts ?? next.ts };
  return { ...next, renders: previous.renders + 1, rendersSince: previous.rendersSince };
}

/** The user's real statusLine command, resolved with Claude's file precedence (project → local →
 *  user). Skips our own injected command so the wrapper can never recurse into itself. */
export function originalCommand(cwd: string, home: string): string | null {
  // Claude's real precedence: project local overrides project, which overrides user.
  const files = [
    `${cwd}/.claude/settings.local.json`,
    `${cwd}/.claude/settings.json`,
    `${home}/.claude/settings.json`,
  ];
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      const cmd = asString(
        asObject(asObject(JSON.parse(readFileSync(f, 'utf8')))?.statusLine)?.command,
      );
      // Skip our OWN injected command (`… status-line` as a standalone subcommand) so the tee can
      // never recurse — but a user script merely CONTAINING "status-line" (e.g. status-line-pretty.sh)
      // is a real statusline and must be run.
      if (cmd !== undefined && cmd !== '' && !/(^|\s)status-line(\s|$)/.test(cmd)) return cmd;
    } catch {
      // skip unreadable/invalid settings file
    }
  }
  return null;
}

const fmtTok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** A minimal default statusline built from the captured metrics — shown ONLY when the user has no
 *  statusline of their own, so injecting the tee never leaves them with a blank bar; instead they get
 *  a useful model + context readout for free. */
export function minimalStatusline(m: MetricsStatus): string {
  const parts: string[] = [];
  if (m.model !== null) parts.push(m.model);
  if (m.pct !== null && m.contextSizeTokens !== null) {
    const used = Math.round((m.contextSizeTokens * m.pct) / 100);
    parts.push(`${fmtTok(used)}/${fmtTok(m.contextSizeTokens)} ${m.pct}%`);
  }
  return parts.join(' · ');
}

export async function cmdStatusLine(): Promise<number> {
  try {
    const raw = await Bun.stdin.text().catch(() => '');
    const self = process.env.CCMUX_SESSION;
    let cwd = '.';
    try {
      cwd = process.cwd(); // can throw if the session's cwd was deleted — degrade, never break render
    } catch {
      // keep default cwd
    }

    const metrics = extractMetrics(raw, Date.now());
    // Capture metrics (best-effort — never let a write failure suppress the visual statusline).
    if (self !== undefined && self !== '' && metrics !== null) {
      try {
        await writeMetricsFile(self, countRender(readMetricsFile(self), metrics));
      } catch {
        // metrics are best-effort
      }
    }

    // Render the user's ORIGINAL statusline (visual unchanged); if they have none, render a minimal
    // default from the metrics rather than a blank bar.
    const cmd = originalCommand(cwd, process.env.HOME ?? '');
    if (cmd !== null) {
      const proc = Bun.spawn(['sh', '-c', cmd], {
        cwd,
        stdin: new TextEncoder().encode(raw),
        stdout: 'inherit',
        stderr: 'ignore',
      });
      await proc.exited;
    } else if (metrics !== null) {
      process.stdout.write(minimalStatusline(metrics));
    }
  } catch {
    // fully fail-open — a statusline hiccup must never surface an error to Claude
  }
  return 0;
}
