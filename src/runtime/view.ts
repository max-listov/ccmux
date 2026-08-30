import type { MachineConfig, Session } from "../types.ts";
import type { PaneScan } from "../agent/index.ts";
import { readManagedRuntimeStatus } from "./status.ts";
import type { ManagedRuntimeRead } from "./schema.ts";

export function managedRuntimeView(m: MachineConfig, s: Session, now = Date.now()): {
  read: ManagedRuntimeRead;
  state: "working" | "idle" | "blocked";
  atPrompt: string | null;
  turnStartedAt: string | null;
  scan: PaneScan;
} {
  const read = readManagedRuntimeStatus(m, s, Math.max(now, Date.now()));
  const native = read.snapshot?.state ?? "unknown";
  const atPrompt = native === "waiting-approval" || native === "waiting-input" ? native : null;
  const state = native === "working" ? "working" : native === "idle" || atPrompt !== null ? "idle" : "blocked";
  return {
    read, state, atPrompt,
    turnStartedAt: native === "working" ? read.snapshot?.turn?.startedAt ?? null : null,
    scan: { ready: read.status === "live", state: native === "unknown" ? "indeterminate" : native === "working" ? "working" : "idle",
      atPrompt, contextLabel: "-", context: { text: null, usedTokens: null, limitTokens: null, percent: null } },
  };
}
