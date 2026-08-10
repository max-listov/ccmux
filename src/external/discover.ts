import type { AgentKind, ExternalSession, MachineConfig } from "../types.ts";
import { ExternalSessionSchema } from "../config/schema.ts";
import { discoverClaude } from "./claude.ts";
import { discoverCodex } from "./codex.ts";

export function discoverExternal(m: MachineConfig): ExternalSession[] {
  const rows = [...discoverClaude(m), ...discoverCodex(m)].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.threadId.localeCompare(b.threadId),
  );
  return ExternalSessionSchema.array().parse(rows);
}

/** Fresh exact lookup. It intentionally re-runs evidence collection instead of using a TUI row. */
export function discoverOne(m: MachineConfig, provider: AgentKind, threadId: string): ExternalSession | null {
  const rows = provider === "claude" ? discoverClaude(m) : discoverCodex(m);
  const row = rows.find((item) => item.threadId === threadId);
  return row ? ExternalSessionSchema.parse(row) : null;
}
