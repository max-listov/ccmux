import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { loadOutbox, type Outbound } from "./outbox.ts";
import { runRemote } from "./transport.ts";
import { run } from "../util/spawn.ts";
import { log } from "../util/log.ts";
import { outboxAckPath } from "../config/paths.ts";
import type { MachineConfig } from "../types.ts";

/**
 * Re-send what never left.
 *
 * Transit between two servers is INTERMITTENT by design: there are no server-to-server keys (a
 * compromised box must not hand over its neighbour), so a machine can only reach another while the
 * owner's forwarded key is present. A send attempted in a gap fails — and until now the honest
 * `[NOT SENT — transport failed]` row was where the story ended. An agent reported, moved on, and
 * its report was lost while a peer waited for it (observed on a live run).
 *
 * So the fix is not "keep the link up" — that would mean weakening the key model — but "survive the
 * link being down": the record we already keep becomes a queue that drains itself when transit
 * returns. Safe only because the send is idempotent (the message id travels, and a receiver ignores
 * an id it already stored), so a retry cannot duplicate — not even when the first attempt actually
 * landed and only our side read it as a failure.
 */

// `outboxAckPath` holds the ids whose delivery is settled — a separate append-only file, exactly
// like the chat ack-log: the outbox stays an immutable record of ATTEMPTS, this says which of them
// ended up delivered.

export function loadOutboxAcked(m: MachineConfig): Set<string> {
  const p = outboxAckPath(m);
  const ids = new Set<string>();
  if (!existsSync(p)) return ids;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o: unknown = JSON.parse(line);
      if (o !== null && typeof o === "object" && "id" in o && typeof o.id === "string") ids.add(o.id);
    } catch {
      // one bad line costs that line, never the file
    }
  }
  return ids;
}

export function appendOutboxAck(m: MachineConfig, id: string): void {
  try {
    const p = outboxAckPath(m);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ id, ts: new Date().toISOString() })}\n`);
  } catch {
    // best-effort: a lost ack costs one harmless extra retry, which is a no-op on the far side
  }
}

/** How long a failed send stays worth retrying. Past this it is stale news — delivering a
 *  day-old "the build is green" is worse than not delivering it. */
export const RETRY_WINDOW_MS = 60 * 60 * 1000;
/** Attempts per tick, so one blackholed host cannot eat the whole delivery loop. */
export const MAX_PER_TICK = 3;

/**
 * Which outbox rows deserve another attempt. Pure — the whole retry policy in one testable place.
 *
 * `restart-then` is deliberately excluded: it is not a message but an ACTION (kill + relaunch +
 * inject a note), and repeating an action is a different question from repeating a letter.
 */
export function retryCandidates(rows: Outbound[], acked: ReadonlySet<string>, nowMs: number, windowMs = RETRY_WINDOW_MS): Outbound[] {
  const out: Outbound[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.ok || r.kind !== "msg") continue;
    if (acked.has(r.id) || seen.has(r.id)) continue;
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** Optional, generic pre-attempt hook: some fleets can restore transit with one local command
 *  (re-pointing a forwarded-key socket, refreshing a token). Run once per flush, never per message,
 *  and only when there is something to retry. Deliberately NOT a named third-party script — ccmux
 *  must not know about anyone's personal tooling. */
const PreflightSchema = z.array(z.string().min(1)).min(1);

async function runPreflight(m: MachineConfig): Promise<void> {
  const parsed = PreflightSchema.safeParse(m.transitPreflight);
  if (!parsed.success) return;
  try {
    await run(parsed.data, { timeoutMs: 15_000 });
  } catch {
    // advisory only — if it fails we still attempt the send and report honestly
  }
}

/**
 * One drain pass. Called from the same loop that delivers chat, so nothing new has to be scheduled.
 * Never throws: this is best-effort recovery, and it must not be able to wedge chat delivery.
 */
export async function flushOutbox(m: MachineConfig): Promise<void> {
  const fleet = m.fleet;
  if (fleet === undefined || Object.keys(fleet).length === 0) return;
  let candidates: Outbound[] = [];
  try {
    candidates = retryCandidates(loadOutbox(m), loadOutboxAcked(m), Date.now());
  } catch {
    return;
  }
  if (candidates.length === 0) return;

  await runPreflight(m);
  for (const rec of candidates.slice(0, MAX_PER_TICK)) {
    const alias = Object.hasOwn(fleet, rec.toMachine) ? fleet[rec.toMachine] : undefined;
    if (alias === undefined) {
      // The machine left the map — nothing to retry against. Settle it so we stop looking.
      appendOutboxAck(m, rec.id);
      continue;
    }
    const argv = ["ccmux", "msg", rec.toSession, ...(rec.task !== null ? ["--task", rec.task] : [])];
    const r = await runRemote(alias, argv, {
      stdin: rec.body,
      // The SAME id as the first attempt — that is what makes this safe to repeat.
      env: { CCMUX_ORIGIN: `${m.rcPrefix}:${rec.from}`, CCMUX_MSG_ID: rec.id },
      timeoutMs: 20_000,
    });
    if (!r.transportFailed && r.code === 0) {
      appendOutboxAck(m, rec.id);
      log.info({ msg: "outbox: delivered on retry", id: rec.id, to: `${rec.toMachine}:${rec.toSession}` });
    }
    // Still no route → leave it queued; the next tick tries again until the window closes.
  }
}
