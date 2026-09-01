---
title: Context usage read from the runtime instead of a statusline scrape
description: Context fill is parsed out of a statusline hook, although a native runtime answers it directly; the fleet slice then drops the field entirely.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:25 +0700
pipeline: native-parity
order: 2
depends-on: 2026-09-01-fleet-json-omits-context-window.md
---

# Заполнение контекста — у runtime, а не из statusline

## Зачем

`src/commands/statusLine.ts` parses `context_window.used_percentage` and
`context_window.context_window_size` out of a statusline payload, and `MetricsStatus` carries them
onward. That is a scrape: it exists because an interactive CLI has no other way to say it.

A native runtime does have another way — `Query.getContextUsage()` returns the numbers the session
itself is measuring, including how the window was resolved (a model's hard limit versus a smaller
compaction window, which the scrape cannot distinguish at all).

Separately, `fleet --json` drops the context field that `list --json` carries, so a remote consumer
cannot show context fill for a session on another machine. Fixing that on top of the scrape would
harden the scrape; the two belong in one pass.

## Результат

- For a native session the published context figures come from the runtime's own answer, with the
  window kind recorded rather than inferred.
- `fleet --json` carries the same context field `list --json` does.
- The interactive path keeps the statusline source; nothing about it changes.

## План

- [x] Read context usage in the native owner and publish it in the runtime snapshot.
- [x] One accessor that answers "context fill for this session" for both sources, so consumers do
      not branch on runtime.
- [x] Carry the field through the fleet projection and its schema.

## Acceptance

- [x] Живая проверка: цифры контекста нативной сессии совпадают с тем, что сообщает сам runtime.
- [x] `fleet --json` отдаёт поле для сессии на другой машине.
- [x] Задача `2026-09-01-fleet-json-omits-context-window.md` закрыта этой работой.

## Что сделано

### Runtime

- [x] `NativeContextUsageSchema` в `src/runtime/projectionSchema.ts`: использовано, предел, СВОЙ
      предел модели, процент и то, **против какого окна** он измерен. Скрейп различить это не может
      в принципе — он видит одно число, а разница «почти полное окно» и «почти точка компакции»
      именно в этом.
- [x] `src/agent/claude/native/context.ts`: `nativeContextUsage` (проекция ответа runtime,
      процент зажат по 100 — превышение реально, но полоса за собственным краем бесполезна) и
      `nativeContextInfo` (та же форма, что у всех остальных сессий).
- [x] Владелец спрашивает `query.getContextUsage()` **на конце хода**, не на каждом тике: это
      round trip, и ответ меняется только вместе с беседой. Неудача — молчание, а не дефект:
      предыдущее измерение остаётся, ноль читался бы как пустое окно.

### Fleet

- [x] `src/runtime/view.ts` отдаёт контекст нативной сессии вместо жёстких `null`: у неё нет панели
      для скрейпа, из-за чего она не сообщала контекст ВООБЩЕ.
- [x] `RemoteSessionSchema` в `src/commands/fleetList.ts` называет `context`, и локальная ветка его
      кладёт. Пир его слал и раньше — терялся он здесь.

### Тесты

- [x] `test/native-context-usage.test.ts`: политика-окно против собственного окна модели, зажим
      процента, «не измеряли» ≠ ноль, форма для потребителя, перенос поля через флотовый срез.

### Живая проверка

- [x] Снапшот: `46072/200000 23% · model-limit`; вид сессии и строка `list` — те же цифры и метка
      `46k/200k 23%`.
- [x] До первого хода поле отсутствует, а не равно нулю.
