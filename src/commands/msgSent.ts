import { sentLetters } from '../chat/sentLetters.ts';
import type { ChatPrincipal, MachineConfig } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';

/** `ccmux msg sent` — prints what `chat/sentLetters.ts` answers. */
export async function msgSent(
  machine: MachineConfig,
  from: ChatPrincipal,
  wanted: string | undefined,
  asJson: boolean,
): Promise<number> {
  const list = sentLetters(machine, from, wanted);
  if (asJson) {
    // One line, through the writer that waits for the pipe, like every other `--json` here.
    await printLine(JSON.stringify(list));
    return 0;
  }
  if (list.sent.length === 0) {
    console.log(
      wanted === undefined
        ? `nothing sent by ${list.sender} is recorded on this machine`
        : `nothing sent by ${list.sender} for task '${wanted}'`,
    );
  } else {
    const now = Date.now();
    const rows = list.sent.map((letter) => [
      humanizeDuration((now - Date.parse(letter.ts)) / 1000),
      letter.task ?? '-',
      letter.to,
      letter.state,
      letter.ref ?? '-',
      // One row, one line: a letter's own newlines would otherwise split the row and leave the
      // columns of every following line meaningless — and a reference read out of a broken table
      // is the reference that gets mistyped.
      letter.preview.replace(/\s+/g, ' '),
    ]);
    for (const line of tableLines(['AGE', 'TASK', 'TO', 'STATE', 'REF', 'TEXT'], rows))
      console.log(line);
    console.log(
      'REF is the sourceMessageRef of a thread-continuation to that recipient under that task. It is offered only for a letter that reached the recipient\u2019s ledger: one still held for retry has not opened a correspondence, and a letter to the owner has no reference at all',
    );
  }
  if (list.fromEarlierLives > 0)
    console.log(
      `${list.fromEarlierLives} more were sent by earlier lives of this session — a continuation references the life that wrote the letter, so their references no longer resolve`,
    );
  return 0;
}
