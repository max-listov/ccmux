---
title: Make live status cheap without a new tmux protocol
description: Take the three measured wins that a rejected control-mode program was reaching for, using surfaces this project already publishes.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 15:28 +0700
priority: P2
related: docs/backlog/icebox/2026-06-09-tmux-control-mode.md
---

## Why

A program to drive tmux through a control connection was rejected on evidence: its push channel
needs one attached client per session, an attached client corrupts the chat-delivery gate, it can
resize a pane a person is working in, and reconstructing the detectors' input needs a terminal
emulator. The measurements behind that rejection also showed where the cost and the latency actually
are, and none of it needs a new protocol.

## Result

- The TUI stops running its own tmux work while the daemon is already publishing the same
  observation.
- The latency a person perceives — new transcript text — is driven by the file changing rather than
  by an interval.
- The working/idle chip is as fresh as the operator wants, by a constant rather than an architecture.

## Plan

- [x] Point the TUI at the snapshot the daemon publishes (`docs/architecture/monitoring-status.md`)
      instead of running `collectRows` on its own interval. Measured: the daemon's observation cycle
      is ~13% of one core and the TUI adds ~2–3% more doing the same work again.
- [x] Watch the transcript JSONL in `useTranscript` instead of polling it every 1500 ms. This is the
      gap between "the agent answered" and "a reader sees it", and it is a file change, not a pane.
- [x] If the chip must be fresher than 2 s, lower `STATUS_INTERVAL_MS`. At ~16 ms per capture the
      budget is there; this is a constant, not an architecture.

## Acceptance

- [x] Live status latency measured before and after, on the same machine and session count.
- [x] The TUI's idle CPU does not rise, and the documented zero-re-renders-when-idle invariant holds.
- [x] No new permanent path is added beside an existing one.

## Что сделано

### Измерение, которое опровергло два пункта из трёх

На реальном флоте (38 сессий в реестре, 15 живых):

| что | медиана |
|---|---|
| `collectRows` целиком | **39.1 мс** |
| он же без захвата панелей | 37.9 мс |
| чтение снапшота демона | **0.3 мс** |

- [x] **Захват панелей — 1.2 мс из 39.** План исходил из того, что дорого именно это. Неверно.
- [x] **Перевести TUI на снапшот демона нельзя как написано.** Выигрыш реален (39 мс → 0.3 мс,
      то есть 2.6% ядра → около нуля), но снапшот не несёт двенадцати полей, которые TUI рисует:
      `stale`, `lastMessage`, `context`, `contextLabel`, `atPrompt`, `uptimeText`, `lifecycleError`,
      `createdAt`, `lastActivityMs`, `account`, `costUsd`, `session`. Заплатить за 2.6% ядра либо
      потерей этих полей, либо расширением намеренно ограниченной проекции, которую читают другие
      потребители, — плохая сделка. Пункт закрыт как отвергнутый по измерению, а не сделанный.
- [x] **`STATUS_INTERVAL_MS` понижать не за чем.** Собственный интервал TUI — 1500 мс, он и так
      плотнее демоновских 2000 мс; свидетельств, что чип должен быть свежее, нет.

### Что сделано по существу

- [x] Транскрипт в TUI ведётся **файлом, а не часами**: `fs.watch` в `useTranscript`, интервал
      остался страховкой и стал реже (4 с). Читатель ждёт «агент ответил», а это запись в jsonl;
      на одном интервале ожидание было длиной в опрос без всякой причины, кроме опроса.
- [x] Страховка сохранена намеренно: `fs.watch` теряет события на части файловых систем и на
      сетевых монтированиях, а тихо переставший обновляться транскрипт хуже запоздавшего.
- [x] Инвариант простоя цел: чтение по-прежнему гейтится по mtime, поэтому событие или тик, ничего
      не изменившие, не стоят ни перечитывания, ни разбора, ни перерисовки.
- [x] `transcriptPath` в `src/agent/index.ts` — путь к беседе сессии без дублирования логики.
- [x] `test/transcript-watch.test.ts`: запись наблюдается задолго до бывшего порога опроса;
      отсутствующий файл не watch'ится и это не ошибка.

### Ошибка в моём же измерении, отброшенная

Первый замер дал «958 мс на чтение транскриптов 15 сессий» — и это не могло быть внутри 39 мс.
`collectRows` читает **кэшированный хвост** (`lastMsgCache` + `readTailLines`), а не транскрипт
целиком. Цифра мерила то, чего код не делает, и в выводы не пошла.

## Acceptance

- [x] Задержка измерена: порог опроса 1500 мс снят, событие файла приходит на порядок раньше.
- [x] Idle-CPU не вырос: гейт по mtime на месте, интервал стал реже, а не чаще.
- [x] Ни одного нового постоянного пути рядом с существующим не добавлено — watch дополняет
      страховочный интервал, а не заменяет собой второй механизм.
