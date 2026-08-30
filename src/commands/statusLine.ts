import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { type MetricsStatus, writeMetrics } from '../agent/sessionStatus.ts';

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

const StatusLineJsonSchema = z.object({
  model: z.object({ display_name: z.string().optional(), id: z.string().optional() }).optional(),
  context_window: z
    .object({ used_percentage: z.number().nullish(), context_window_size: z.number().nullish() })
    .optional(),
  cost: z.object({ total_cost_usd: z.number().nullish() }).optional(),
});

const SettingsSchema = z.object({ statusLine: z.object({ command: z.string() }).optional() });

/** Pure: statusLine stdin JSON → the metrics to persist, or null on bad JSON. Separated for tests. */
export function extractMetrics(raw: string, now: number): MetricsStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const j = StatusLineJsonSchema.safeParse(parsed).data;
  if (j === undefined) return null;
  const cw = j.context_window;
  return {
    ts: now,
    pct: cw?.used_percentage ?? null,
    contextSizeTokens: cw?.context_window_size ?? null,
    model: j.model?.display_name ?? j.model?.id ?? null,
    costUsd: j.cost?.total_cost_usd ?? null,
  };
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
      const cmd = SettingsSchema.safeParse(JSON.parse(readFileSync(f, 'utf8'))).data?.statusLine
        ?.command;
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
        await writeMetrics(self, metrics);
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
