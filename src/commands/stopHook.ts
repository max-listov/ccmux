import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { loadLedger, loadAckedIds, appendAck } from "../chat/store.ts";
import { formatChatInjection } from "../chat/format.ts";

/**
 * `ccmux stop-hook` — the Claude Code **Stop hook** for a managed session. It fires ONLY when the
 * agent VOLUNTARILY finishes a turn (never mid-turn, never on interrupt — verified). It drains this
 * session's undelivered DEFERRED chat mail and injects it as the agent's next turn via
 * `{decision:"block","reason":…}`, so a follow-up arrives exactly at end-of-turn, human-weighted,
 * without the steering that would interrupt mid-work.
 *
 * Identity is the env `CCMUX_SESSION` (set at launch, inherited by the hook subprocess) — NOT the
 * payload `session_id`, which diverges from the registry uuid after Claude forks a conversation.
 *
 * Coordination with the daemon (R5): delivery is tracked in the append-only ack-log (by message id),
 * never in the shared cursors file. We record acks BEFORE emitting the block (fail-closed: if we
 * can't durably ack, we don't inject → the message is never lost to a phantom delivery and there is
 * no `block`→turn→`block` loop). The daemon, seeing the ack, advances its own cursor past the
 * message on its next pass. The daemon (idle target) and this hook (end-of-turn) are temporally
 * disjoint — a target can't be "stably idle for the grace window" and "just ended a turn" at once —
 * so a double-inject race effectively cannot occur; the ack check is the belt regardless.
 *
 * The whole thing is wrapped fail-open: ANY error exits 0 with no output, so a chat hiccup can never
 * wedge a session's ability to stop.
 */
export async function cmdStopHook(): Promise<number> {
  try {
    // Drain stdin (the Stop payload) so the hook never blocks on an unread pipe. We don't need its
    // fields: identity is CCMUX_SESSION, and there is no `stop_reason` in the payload to gate on.
    await Bun.stdin.text().catch(() => "");

    const self = process.env.CCMUX_SESSION;
    if (self === undefined || self === "") return 0; // not a managed session → nothing to do

    const m = loadMachineConfig();
    const me = findSession(loadSessions(m), self);
    if (!me || !me.chatEnabled) return 0; // chat off for this session → cheap no-op

    // Deliver each DEFERRED message to this session that hasn't been injected yet (ack-log dedups by
    // id — the single source of truth for conditional delivery, shared with the daemon; the daemon
    // stays the sole writer of the cursors file). A defer message may also carry notBefore (a delayed
    // dispatch) — respect it here too, so end-of-turn never delivers a not-yet-due message.
    const acked = loadAckedIds(m);
    const now = Date.now();
    const due = (iso: string | null) => iso === null || !Number.isFinite(Date.parse(iso)) || now >= Date.parse(iso);
    const pending = loadLedger(m).filter((msg) => msg.to === self && msg.defer && !acked.has(msg.id) && due(msg.notBefore));
    if (pending.length === 0) return 0; // no deferred mail → let the turn end cleanly

    // Record acks FIRST (durable, fail-closed) so neither this hook nor the daemon re-delivers.
    for (const msg of pending) appendAck(m, msg.id, "hook", self);

    const reason = pending.map(formatChatInjection).join("\n\n");
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return 0;
  } catch {
    // Fail-open: never break the session's ability to stop over a chat problem.
    return 0;
  }
}
