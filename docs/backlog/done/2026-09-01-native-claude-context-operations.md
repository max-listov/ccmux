---
title: History, fork and compaction for the native Claude mode
description: Four context operations the control plane already serves for other native runtimes are declared false for Claude, although its runtime supports every one of them.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:42 +0700
pipeline: native-parity
order: 3
depends-on: 2026-09-01-native-session-control.md
---

# Операции контекста для нативного Claude

## Зачем

`src/context/` already implements bounded history reads, compaction and fork as mailbox operations
served by whichever owner process holds the connection; `NativeContextApi` is a three-method
interface and both Codex and OpenCode provide it. The native Claude owner provides none, so
`history`, `fork` and `compaction` are declared false in `src/runtime/capabilities.ts` and the
control plane refuses all three.

The runtime supports each: a conversation transcript is its own source of truth, compaction is a
command the session accepts, and forking is `forkSession` / `resumeSessionAt` — a first-class
operation, not an improvisation.

`rollback` stays refused, as it is for the other native runtimes: a conversation the runtime will
not un-say is not something to pretend about.

## Результат

- A caller can page a native Claude session's history through the same bounded contract the other
  runtimes answer.
- A caller can compact a native Claude session and see the compaction boundary in its stream.
- A caller can fork a native Claude conversation into a new managed session that resumes from a
  chosen message, with both identities pinned as the mode already pins them.

## План

- [x] `claudeContextApi` implementing `NativeContextApi`, wired into the owner's context pump.
- [x] Record the compaction boundary the runtime emits, so the marker is observed rather than guessed.
- [x] Fork through the runtime's own fork, adopted as a managed session with a pinned identity and
      excluded from discovery/adoption exactly as the mode already excludes its conversations.
- [x] Flip only the capabilities that now have an implementation behind them.

## Acceptance

- [x] Живая проверка: страница истории, компакция с видимой границей, форк, который продолжает
      беседу с выбранного сообщения.
- [x] `rollback` по-прежнему отказывает, и отказ назван причиной, а не молчанием.

## Что сделано

### Runtime

- [x] `src/context/claude.ts`: `claudeContextApi` реализует `NativeContextApi` — история, маркер
      компакции, компакция. Подключён к владельцу через `NativeContextPump`.
- [x] История читается из **транскрипта самого runtime**, а не из живого буфера содержимого:
      буфер — ограниченное окно последних элементов, и листать по нему назад значило бы отвечать
      фактом про окно на вопрос про беседу.
- [x] Корень транскрипта резолвится так же, как его резолвит runtime (`CLAUDE_CONFIG_DIR` или
      `~/.claude`), а не из `projectsDir` машины: это разные процессы с разной конфигурацией, и
      чужой каталог выдал бы пустую беседу за полную. Отсутствие файла — «неизвестно», а не «пусто».
- [x] Компакция идёт **командой из фазы 1**, а не вторым механизмом: второй путь к той же беседе —
      ровно то, против чего существует правило одного writer.
- [x] Граница компакции наблюдается по записи, которую пишет сам runtime, и публикуется в истории
      отдельным видом `compaction`: транскрипт пишет её системной записью без содержимого, поэтому
      обычный парсер не давал ничего и беседа выглядела просто прыгнувшей.
- [x] Форк — через `forkSession` самого runtime, принятый ledger'ом однократной выдачи; владелец
      берёт возвращённый id как свою беседу, а `process.ts` продвигает и сверяет РАЗРЕШЁННУЮ
      идентичность, а не предположенную.

### Дефекты, найденные по дороге

- [x] Разрешение форка было прибито к именам `codex`/`opencode` вместо capability — та же ошибка,
      что и с effort и с каталогом моделей. Теперь спрашивается `runtimeCapabilities(...).fork`.
- [x] Выбор модели у claude отказывался всегда («provider-owned»), из-за чего форк нативной сессии,
      обязанный нести модель источника, отклонялся. Тоже переведено на capability.
- [x] Форк не передавал режим исполнения: назначение создавалось интерактивным, то есть панель
      смотрела бы на беседу, которую никто не пишет.
- [x] Источник форка брал выбор только из retained-хранилища, которое пустое у сессии на дефолте
      допуска, — такая сессия объявлялась неформируемой. Добавлен откат на выбор из снапшота.
- [x] Ветка форка передавала наш id хода как `upToMessageId`; это должен быть uuid сообщения
      транскрипта, и runtime отказывал в форке целиком. Теперь точка ветвления передаётся, только
      если она действительно uuid.
- [x] **Диагностика затирала сама себя**: файл был один на сессию, поэтому обобщающая ошибка,
      записанная мгновением позже, уничтожала настоящую причину — и в записи оставалось
      «requires reconciliation» без указания, чего именно. Ключ теперь включает stage. Именно эта
      правка и показала настоящую причину отказа форка.

### Тесты

- [x] `test/native-claude-context.test.ts`: корень транскрипта, распознавание границы компакции,
      сохранение вердикта транскрипта, объявленные операции против отказанного rollback.

### Живая проверка

- [x] История: страница из 8 записей, вторая страница по курсору, виды `user`/`tool`/`assistant`/
      `reasoning-summary`/`compaction`.
- [x] Дефект дублирования записей найден живым прогоном (каждая строка читалась дважды) и исправлен.
- [x] Компакция: операция `completed`, ревизия контекста 1, граница в транскрипте и в истории,
      маркер читается.
- [x] Форк: отдельная сессия, беседа `0ba71743…` — не источник и не своя генерация; транскрипт
      форка существует и несёт исходную беседу.
