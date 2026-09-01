---
title: File checkpoints and rewind for the native mode
description: The runtime can track and restore the files a session modified; nothing exposes it, so undoing an agent's edits is a git problem the operator solves by hand.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:51 +0700
pipeline: native-parity
order: 5
depends-on: 2026-09-01-native-claude-context-operations.md
---

# Чекпоинты файлов и откат

## Зачем

The runtime can back up every file before it modifies it and restore that state on request. Nothing
here asks for it, so undoing what a session did to a working tree is manual — and manual is exactly
where the review buffer gets destroyed, because the fastest reflex is a hard reset over changes
nobody meant to lose.

This is the one item in this program that widens what the project is answerable for: today a session
owns its conversation, and after this it also owns a record of the files it touched.

## Результат

- File checkpointing is enabled per session by explicit option, off by default.
- A caller can preview what a rewind would restore before performing it, and perform it.
- A rewind that cannot safely restore a path says so instead of silently skipping it.

## План

- [x] Enable checkpointing behind a session option and record that it is on in the snapshot.
- [x] Typed operations to preview and to perform a rewind to a chosen user message.
- [x] Report refusals — a path that is no longer a regular file, a backup that cannot be read —
      rather than counting them as success.

## Границы

Rewind restores files, not the conversation: it must never be presented as undoing what was said.
It stays off unless a session asks for it, because a supervisor that silently starts copying a
working tree is a surprise, not a feature.

## Acceptance

- [x] Живая проверка: файл изменён ходом, откат возвращает прежнее содержимое.
- [x] Живая проверка: предпросмотр называет ровно те файлы, которые вернёт.
- [x] Отказ по небезопасному пути виден в ответе, а не только в логе.
- [x] Сессия без опции не создаёт ни одного бэкапа.

## Что сделано

### Runtime

- [x] `fileCheckpoints` — поле сессии (`src/config/schema.ts`), принимаемое при создании
      (`src/commands/create.ts`). По умолчанию выключено и решается **на сессию**, а не на хост:
      супервайзер, который молча начинает копировать рабочее дерево, — сюрприз, а не фича.
- [x] Владелец передаёт `enableFileCheckpointing` только когда сессия его попросила, и публикует
      `fileCheckpoints` в снапшоте: откат возможен лишь там, где копии есть, и узнавать об этом
      после факта поздно.
- [x] `src/runtime/rewind.ts` — почтовый ящик запроса и его ответ; `dryRun` несётся полем, а не
      отдельной операцией, потому что предпросмотр и действие обязаны считаться одним кодом.
- [x] Откат применяется **между ходами**: восстановить файлы под работающим ходом значит поменять
      дерево, о котором он рассуждает, на середине.
- [x] Повтор той же операции возвращает тот же результат: повторный настоящий откат восстановил бы
      файлы поверх работы, сделанной после первого, — это противоположность отмены.
- [x] `skippedLinks` у предпросмотра — `null`, у настоящего отката — число, включая 0. Ноль значит
      «отказов не было», null — «никто не смотрел», и это разные факты.

### Control plane

- [x] Операция `rewind` в контракте (`/rewind`) и capability `fileCheckpoints`, объявленная только
      для нативного профиля.

### Тесты

- [x] `test/native-rewind.test.ts`: отсутствие счётчика отказов у предпросмотра, ноль против
      «не измеряли», отказ с причиной вместо пустого успеха, объявление capability.

### Живая проверка

- [x] Сессия `natcp` создана с опцией; снапшот сообщает `fileCheckpoints: true`. Сессия без опции
      сообщает `false` и копий не делает.
- [x] Ход переписал файл `ДО` → `ПОСЛЕ` (через одобрение инструмента по control plane).
- [x] Предпросмотр назвал ровно этот файл (`insertions: 1, deletions: 1`) и файл не тронул.
- [x] Настоящий откат вернул содержимое `ДО`, `skippedLinks: 0`.
- [x] Повтор той же операции вернул тот же результат, а не второй откат.
