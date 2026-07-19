import type { ChatMessage, MachineConfig, TelegramConfig } from "../types.ts";
import { log } from "../util/log.ts";
import { loadCursors, loadLedger, OWNER, saveCursors } from "./store.ts";

const SEND_TIMEOUT_MS = 10_000;

/** Escape the three chars Telegram's HTML parse_mode treats as markup, so arbitrary message bodies
 *  (which may contain `<`, `>`, `&`) render verbatim and never trip a 400 that would drop the message. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Mirror text for one message (Telegram HTML parse_mode). Multi-line is fine here — a Telegram
 *  message, not a TTY. The first line is the routing header (`from → to`, or `📩 for you — from …`
 *  for a message to the human `owner`) and is bolded so you can tell at a glance who is talking to
 *  whom; the body follows as plain text. All dynamic parts are HTML-escaped. */
export function formatForTg(msg: ChatMessage): string {
  const task = msg.task ? ` · task: ${escapeHtml(msg.task)}` : "";
  const from = escapeHtml(msg.from);
  const to = escapeHtml(msg.to);
  const header = msg.to === OWNER ? `📩 for you — from ${from}${task}` : `${from} → ${to}${task}`;
  return `<b>${header}</b>\n${escapeHtml(msg.body)}`;
}

/** HTTP status → retry policy. 4xx except 429 = permanent (bad token/chat/thread — skip so one bad
 *  message never freezes the mirror). 429 + 5xx = transient (hold, retry next pass). */
export function classifyHttpStatus(status: number): "permanent" | "transient" {
  return status >= 400 && status < 500 && status !== 429 ? "permanent" : "transient";
}

async function sendTelegram(tg: TelegramConfig, text: string): Promise<"ok" | "permanent" | "transient"> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text,
        parse_mode: "HTML",
        ...(tg.topicId !== undefined ? { message_thread_id: tg.topicId } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS), // outbound call always bounded (never hang the loop)
    });
    return res.ok ? "ok" : classifyHttpStatus(res.status);
  } catch {
    return "transient"; // network / timeout → retry next pass
  }
}

/**
 * Mirror any un-mirrored ledger messages to Telegram (a BROADCAST sink — every message, in order).
 * Fail-soft: no telegram config → no-op (chat core is unaffected). A transient failure HOLDS the
 * cursor (retry next pass, so a restart resends only the backlog); a permanent failure (bad
 * token/chat) SKIPS that one message so it never freezes the mirror. Cheap when caught up.
 */
export async function mirrorPending(m: MachineConfig): Promise<void> {
  const tg = m.telegram;
  if (tg === undefined) return;
  const ledger = loadLedger(m);
  const cursors = loadCursors(m);
  const start = cursors.telegram;
  if (start >= ledger.length) return;

  let cur = start;
  while (cur < ledger.length) {
    const msg = ledger[cur];
    if (msg === undefined) {
      cur++;
      continue;
    }
    const result = await sendTelegram(tg, formatForTg(msg));
    if (result === "transient") {
      log.warn({ msg: "telegram mirror transient failure — holding, retry next pass", from: msg.from, to: msg.to });
      break; // hold at `cur` — do not advance past an un-sent message
    }
    if (result === "permanent") {
      log.warn({ msg: "telegram mirror permanent failure — skipping message", from: msg.from, to: msg.to });
    }
    cur++; // ok or permanent → move past it
  }
  if (cur !== start) await saveCursors(m, { ...cursors, telegram: cur });
}
