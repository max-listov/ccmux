import type { ChatMessage, MachineConfig, TelegramConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { courierNote } from './external.ts';
import { humanLabel, humanTargetLabel, principalLabel, targetLabel } from './identity.ts';
import { loadCursors, loadLedger, saveCursors } from './store.ts';

const SEND_TIMEOUT_MS = 10_000;

/** Escape the three chars Telegram's HTML parse_mode treats as markup, so arbitrary message bodies
 *  (which may contain `<`, `>`, `&`) render verbatim and never trip a 400 that would drop the message. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Mirror text for one message (Telegram HTML parse_mode). Multi-line is fine here — a Telegram
 * message, not a TTY. The bolded first line is the route; the body follows as plain text, with every
 * dynamic part HTML-escaped.
 *
 * The route is written for a PERSON — `machine:session`, both sides. It used to carry the full agent
 * address, provider and thread uuid included, on the reasoning that every line should be copyable
 * into `ccmux msg`. On a phone that reasoning does not survive contact: the two uuids were 55% of a
 * 130-character header, and nobody types one, because this mirror is one-way — there is nothing to
 * reply to from Telegram. `machine:session` is already unique across the fleet, which is the whole
 * point of fleet addressing, and a managed session pins one thread at creation, so the uuid
 * separates nothing a reader needs. What stays exact is the pane tag, where an agent really does
 * copy the address to answer.
 */
export function formatForTg(msg: ChatMessage, externals: Record<string, string> = {}): string {
  // A letter addressed OUTSIDE the fleet is not a notification, it is an errand: the person reading
  // it is the transport, so it carries where to take it and the one command that brings the answer
  // back. Rendering it like ordinary mail would leave the reader to work out that they are the
  // route — and an answer nobody records leaves the letter waiting forever.
  if (msg.to.kind === 'external') {
    const where = externals[msg.to.name] ?? 'no route recorded on this machine';
    return `📤 <b>[${escapeHtml(humanLabel(msg.from))} → outside the fleet]</b>\n\n<pre>${escapeHtml(courierNote(msg.to.name, where, msg.body, msg.task))}</pre>`;
  }
  const from = escapeHtml(humanLabel(msg.from));
  // Mail to the human keeps the SAME shape rather than inverting the sentence — one route line to
  // learn to read, with the emoji doing the "this one is for you" work.
  const to = escapeHtml(humanTargetLabel(msg.to));
  const mark = msg.to.kind === 'owner' ? '📩 ' : '';
  const task = msg.task ? ` · <i>${escapeHtml(msg.task)}</i>` : '';
  // Blank line between route and body: on a phone the two ran together and the header stopped
  // reading as a header.
  return `${mark}<b>[${from} → ${to}]</b>${task}\n\n${escapeHtml(msg.body)}`;
}

/** HTTP status → retry policy. 4xx except 429 = permanent (bad token/chat/thread — skip so one bad
 *  message never freezes the mirror). 429 + 5xx = transient (hold, retry next pass). */
export function classifyHttpStatus(status: number): 'permanent' | 'transient' {
  return status >= 400 && status < 500 && status !== 429 ? 'permanent' : 'transient';
}

async function sendTelegram(
  tg: TelegramConfig,
  text: string,
): Promise<'ok' | 'permanent' | 'transient'> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text,
        parse_mode: 'HTML',
        ...(tg.topicId !== undefined ? { message_thread_id: tg.topicId } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS), // outbound call always bounded (never hang the loop)
    });
    return res.ok ? 'ok' : classifyHttpStatus(res.status);
  } catch {
    return 'transient'; // network / timeout → retry next pass
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
  // First run on this machine: adopt the present as the starting point and send nothing. A mirror is
  // a live feed of what happens from now on; replaying history would dump every past conversation
  // into the chat the moment someone configures a bot.
  if (cursors.telegram === null) {
    await saveCursors(m, { ...cursors, telegram: ledger.length });
    log.info({
      msg: 'telegram mirror armed — starting from now, history not replayed',
      from: ledger.length,
    });
    return;
  }
  const start = cursors.telegram;
  if (start >= ledger.length) return;

  let cur = start;
  while (cur < ledger.length) {
    const msg = ledger[cur];
    // Either past the end, or a record this build cannot read. Both are stepped over: the mirror is
    // a feed of what happened, and a message we cannot render is not one we can forward.
    if (msg === undefined || msg === null) {
      cur++;
      continue;
    }
    const result = await sendTelegram(tg, formatForTg(msg, m.externals));
    if (result === 'transient') {
      log.warn({
        msg: 'telegram mirror transient failure — holding, retry next pass',
        from: principalLabel(msg.from),
        to: targetLabel(msg.to),
      });
      break; // hold at `cur` — do not advance past an un-sent message
    }
    if (result === 'permanent') {
      log.warn({
        msg: 'telegram mirror permanent failure — skipping message',
        from: principalLabel(msg.from),
        to: targetLabel(msg.to),
      });
    }
    cur++; // ok or permanent → move past it
  }
  if (cur !== start) await saveCursors(m, { ...cursors, telegram: cur });
}
