---
title: Native runtime parity — program index
description: The native Claude mode is better than the interactive one by protocol and poorer by control; this program closes the six gaps that keep it from being a default.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:54 +0700
pipeline: native-parity
order: 0
depends-on: —
---

# Native runtime parity

## Зачем

The optional native Claude mode ships a typed stream, structured approvals, model selection, effort
and image input. What it does not ship is **control**: an interactive session can be sent a slash
command by keystroke and a native one cannot be sent one at all (`src/commands/send.ts` answers
"this runtime has no terminal composer"), its permission mode is a constant in `owner.ts`, and the
four context operations the control plane already exposes — history, fork, compaction, rollback —
are declared false for it while Codex and OpenCode declare them true.

Two further gaps are not Claude-specific: the context percentage is scraped from a statusline hook
although every native runtime can be asked directly, and nothing anywhere answers "which session is
spending whose account".

A mode that is richer in protocol and poorer in operation cannot become the default, and a mode that
never becomes the default is a permanent second path.

## Фазы

| order | задача | результат, который разблокирует следующую |
|---|---|---|
| 1 | `2026-09-01-native-session-control.md` | слэш-команды и permission mode ходят через mailbox |
| 2 | `2026-09-01-context-usage-from-runtime.md` | заполнение контекста берётся у runtime, а не из statusline |
| 3 | `2026-09-01-native-claude-context-operations.md` | history / fork / compaction у claude native |
| 4 | `2026-09-01-fleet-account-and-spend.md` | видно, какая сессия чей аккаунт расходует |
| 5 | `2026-09-01-file-checkpoints-and-rewind.md` | правки агента откатываются |
| 6 | `2026-09-01-per-session-mcp-management.md` | MCP-серверы сессии видны и управляемы |

## Границы, где фазы соприкасаются

Phases 1 and 3 both add owner-side handlers to the native Claude owner; phase 1 lands the command
path and phase 3 reuses it for compaction rather than inventing a second one. Phase 2 touches the
shared status projection that every runtime publishes — it must not change what the interactive
modes already report. Phase 5 is the only one that widens what this project is responsible for
(the working tree, not just the session), and it stays behind an explicit option.

## Acceptance

- [x] Каждая фаза закрыта своей задачей с живой проверкой.
- [x] Ни одна фаза не ломает интерактивный режим: его capability-строка остаётся байт-в-байт той же.

## Что сделано

Все шесть фаз закрыты своими задачами в `done/`, каждая с живой проверкой на изолированном
инстансе. Нативный режим больше не беднее интерактивного по управлению.

### Одна ошибка, найденная пять раз

Пять отдельных мест решали, что можно делать, по **имени runtime**, а не по объявленной
возможности:

| место | что ломалось |
|---|---|
| `validateTurnOptions` | проверка effort была веткой `runtime === 'codex'`, и любой claude-ход с effort шёл мимо неё |
| маршрутизация каталога моделей | интерактивная сессия получала ответ нативного режима |
| разрешение форка | список `codex`/`opencode` вместо capability |
| выбор модели при создании | `runtime === 'claude'` отказывал всегда, из-за чего форк нативной сессии был невозможен |
| `effort` в схеме | закрытый enum из пяти имён рядом с каталогом, который знает уровни **по модели** |

Каталог при этом отвечает по модели: `haiku` не принимает ни одного уровня effort, остальные —
пять. Ни один список имён в коде такое выразить не мог.

### Дефект наблюдаемости, найденный по дороге

Диагностика хранилась по одному файлу на сессию, поэтому обобщающая ошибка затирала настоящую
причину. Ключ теперь включает stage — и именно эта правка показала, почему отказывал форк.
