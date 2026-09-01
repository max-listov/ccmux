---
title: Slash commands and permission mode for the native runtime
description: A native session accepts no slash command at all and runs on a hardcoded permission mode; both are ordinary session control the interactive mode already has.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:18 +0700
pipeline: native-parity
order: 1
depends-on: —
---

# Управление нативной сессией

## Зачем

`src/commands/send.ts` refuses a native session outright: "this runtime has no terminal composer".
That is correct about the pane and wrong as an answer — the runtime accepts a slash command as an
ordinary turn, and `Query.supportedCommands()` lists which ones exist. So today an interactive
session can be told `/compact`, `/clear`, `/model`, and a native one cannot be told anything.

`src/agent/claude/native/owner.ts` passes `permissionMode: 'default'` as a constant and never calls
`Query.setPermissionMode`. An operator cannot put a native session into plan mode, cannot let it
accept edits, cannot lift it to bypass — while a Codex turn carries `mode: 'default' | 'plan'` in
its turn options.

## Результат

- A caller can list the slash commands a native session supports and run one, through the typed
  control plane, with the same receipt discipline as a message.
- A caller can read and change a native session's permission mode; the change is published in the
  session's own snapshot so a reader sees the mode a turn will run under.
- `ccmux send` still refuses to press keys at a native pane, and now names the operation that does
  work instead of only saying no.

## План

- [x] `commands` operation on the control contract: list what the runtime supports for this session.
- [x] Command dispatch through the existing runtime input mailbox, not a second channel: a slash
      command is a turn, and its receipt/turn lifecycle must be the one already implemented.
- [x] `permissionMode` in the published snapshot and a typed operation to set it, applied through
      `Query.setPermissionMode`.
- [x] Capability flags for both, declared only for the modes that serve them.
- [x] `send` error text names the working alternative.

## Acceptance

- [x] Живая проверка: `/compact` в нативной сессии выполняется и виден в её собственном потоке.
- [x] Живая проверка: сессия переведена в plan mode, и следующий ход действительно не пишет файлы.
- [x] Интерактивная capability-строка не изменилась.

## Что сделано

### Runtime

- [x] Каталог команд публикуется владельцем: `src/agent/claude/native/commands.ts`
      (`claudeCommands`, `writeClaudeCommands`, `readClaudeCommands`, `resolveCommand`,
      `commandText`). Список берётся у runtime через `query.supportedCommands()`.
- [x] Имя команды хранится без ведущего слэша: слэш — способ ЗАПИСИ, а не часть идентичности,
      и хранение обеих форм провоцирует сверку по неверной.
- [x] Алиасы резолвятся в свою команду, иначе половина словаря runtime отказывалась бы.
- [x] `permissionMode` в снапшоте (`src/runtime/projectionSchema.ts`) и почтовый ящик запроса
      `src/runtime/sessionMode.ts`; владелец применяет через `query.setPermissionMode`.
- [x] Режим меняется ТОЛЬКО между ходами: смена посреди хода сдвинула бы границу под уже
      осуждённым вызовом инструмента.
- [x] Приёмкой считается опубликованный снапшот, а не факт записи файла запроса.

### Control plane

- [x] Три операции в контракте: `commands` (чтение), `command` (запуск), `permissionMode`
      (установка) — `src/control/contract.ts`, `src/control/command.ts`.
- [x] Команда идёт через тот же runtime mailbox, что и сообщение, но **мимо chat ledger**:
      ledger обрамляет каждое сообщение атрибуцией отправителя, и слэш-команда с этим префиксом
      перестаёт быть командой. В `RuntimeInputSchema` добавлен `kind: 'message' | 'command'`.
- [x] Идемпотентность по `operationId`: повтор той же операции — тот же ход, не второй.
- [x] Команда, которой runtime не называл, отказывается, а не отправляется как текст.
- [x] `commandCatalog` и `permissionModes` в capabilities, объявлены только для нативного профиля.
- [x] `send` называет работающую альтернативу вместо одного «нет».

### Тесты

- [x] `test/native-session-control.test.ts`: имена и алиасы, текст команды, отказ незнакомой,
      объявление capability только для нативного режима.

### Живая проверка

- [x] Опубликовано 84 команды, среди них `/compact`.
- [x] Режим `default` → `plan`, подтверждён снапшотом сессии.
- [x] `/context` доставлена и распознана runtime **как команда**: в транскрипте
      `<command-name>/context</command-name>`, а не текст.
- [x] Повтор той же операции вернул тот же ход.
- [x] В plan mode ход НЕ создал файл, а запросил `ExitPlanMode` — то есть режим реально действует.
- [x] Интерактивная capability-строка не изменилась (проверено тестом на равенство всей записи).
