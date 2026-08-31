---
title: The startup menu answerer presses its key repeatedly and types into live conversations
description: A supervised session's prompt settler re-answers the same menu every poll for 45 seconds, so its keystroke reaches a composer that is no longer a menu — blocking the session's mail or submitting a turn nobody wrote.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 00:07 +0700
priority: P1
---

## Problem and evidence

`settlePrompts` in `src/commands/run.ts` answers a blocking startup menu on an unattended resume.
Its own comment describes it as "one-shot + bounded". It is neither: the loop polls every second
until a 45-second deadline and re-answers whenever the detector still matches, with no memory of
what it already pressed and no requirement that the previous answer changed anything.

Recorded by the daemon itself over four days, from its own log:

- **86 keystrokes, every one of them `2`**, across 10 sessions.
- Up to **8 presses into a single session**, about 1.5 seconds apart — the loop's own cadence.

The damage happens when the menu is gone but the detector still matches, because the keystroke then
lands in a live composer:

- Without the follow-up Enter, a bare `2` sits in the composer. An occupied composer holds **every
  message addressed to that session**, silently and indefinitely — the same failure that once held
  one session's mail for eleven hours.
- With the follow-up Enter, the `2` is **submitted as a user turn**. Two such turns arrived in a
  supervised session on 2026-09-01, immediately after a mass restart at 00:00:16 +07 and the
  presses logged at 00:00:42–00:00:53 +07.

Both symptoms were previously investigated from the wrong end: five composers found holding an
identical `«2»` were treated as stray human input, because a keystroke sent to a pane leaves no
record distinguishing it from something a person typed. The daemon's own log named the source.

## Result

- A detected menu is answered **at most once**. An answer that does not clear it is reported, not
  repeated: pressing again is precisely how a keystroke reaches a live conversation.
- The legitimate case the loop was written for — startup raising two menus in a row, folder trust
  then the resume picker — still works, because a further answer is allowed only after the pane was
  observed free of any menu.
- No supervised session receives a keystroke the supervisor cannot justify from the pane in front
  of it at that moment.

## Открытый вопрос

Why the detector kept matching after the menu was answered is not established: it may be a live
menu the keystroke never reached, or menu text still inside the 20-line tail after the pane
repainted. The fix does not depend on which — answering once is correct either way — but the
distinction decides whether a session is ever genuinely left stranded at a menu, and that should be
observable rather than assumed.

## Что сделано

- [x] `src/commands/run.ts` — `settleStep` holds the whole rule as a pure function and carries the
      authorised key with its decision, so a caller cannot press one the rule did not agree to. The
      arming is spent by answering and restored only by observing the pane with **no** menu on it.
- [x] The loop answers each menu once. Two menus in a row are still both answered, because a clear
      pane between them is the evidence that the second is a different menu. An answer that does not
      clear ends the watch instead of repeating.
- [x] `test/prompt-settle.test.ts` — 6 checks. The first replays the defect as the sequence that
      produced it: eight consecutive polls showing a menu now yield one press and a stop.
- [x] `docs/architecture/session-events.md` records the asymmetry the design rests on — a missed
      menu strands a session in a state every other signal already reports, while a key pressed into
      a live conversation is silent and unrecoverable.

## Как это нашлось, и чего это стоило

The daemon had been naming the source in its own log for four days. Two separate investigations
went the other way first — five composers holding an identical character were read as stray human
input, and an eleven-hour mail hold was attributed to a person's unsent draft — because a key sent
to a pane leaves no record distinguishing it from something a person typed. The cheapest probe was
the log, and it was not opened until the third occurrence.

## Открытый вопрос — сознательно оставлен

- [x] Why the detector kept matching after a menu was answered is still not established: a live menu
      the keystroke never reached, or menu text still inside the 20-line tail after a repaint. The
      fix is correct either way, and answering once is what removes the damage. What remains
      unanswered is whether a session is ever genuinely left stranded — now observable, because the
      supervisor stops and says so instead of pressing until the window expires.

## Точность отчёта

Of the three bare `2` turns that prompted this, only the first was the defect: the daemon's last
keystroke into any session was 17:01:16Z and the later two arrived minutes after that. The bug is
real and is fixed; it did not send all three, and saying otherwise would have made the evidence look
tidier than it was.
