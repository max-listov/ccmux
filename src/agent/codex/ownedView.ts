import type { MachineConfig, Session } from "../../types.ts";
import type { PaneScan } from "../index.ts";
import { readOwnedCodexStatus } from "./ownedStatus.ts";
import type { OwnedCodexRead } from "./ownedSchema.ts";

export function ownedCodexView(m: MachineConfig, s: Session, now = Date.now()): {
  read: OwnedCodexRead;
  state: "working" | "idle" | "blocked";
  atPrompt: string | null;
  turnStartedAt: string | null;
  scan: PaneScan;
} {
  const read = readOwnedCodexStatus(m, s, Math.max(now, Date.now()));
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
