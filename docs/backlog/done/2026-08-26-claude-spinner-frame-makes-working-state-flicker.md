---
title: Кадр анимации Claude заставляет working-сессию мигать в idle
description: list --json принимает отсутствие spinner в одном capture-pane за окончание хода, хотя lifecycle всё ещё working и тот же живой ход продолжается.
type: task
status: done
tags: [claude, state, pane, fleet, events]
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 14:14 +0700
related:
  - docs/architecture/session-events.md
  - docs/backlog/done/2026-08-25-snapshot-tells-when-the-current-turn-began.md
---

# Кадр анимации Claude заставляет working-сессию мигать в idle

## Что видно снаружи

На `ccmux 0.39.0` один и тот же реально идущий Claude turn меняет состояние между соседними
вызовами `ccmux list --json`, хотя процесс, thread и `UserPromptSubmit` lifecycle не менялись:

```text
session-a=working  session-b=working
session-a=idle     session-b=working
session-a=idle     session-b=idle
session-a=working  session-b=idle
session-a=working  session-b=working
```

В живом probe восемь последовательных снимков за 1,4 секунды дали все эти переходы. Оба хода в
это время продолжали исполняться; у обоих был тот же ненулевой `turnStartedAt` до и после провала.
`fleet --json` переносит результат как есть, поэтому любой dashboard видит то одну, то несколько
`working`-сессий без реального turn boundary.

## Решающий пробник

Двадцать быстрых `capture-pane` одного и того же идущего хода разделились на две серии:

```text
01..09  no-working-marker  ready
10..20  working-marker     ready  ✳/✶/✻/✽ Computing…
```

То есть интерфейс Claude всё время нарисован (`ready=true`), но live spinner присутствует в plain
tmux snapshot не на каждом кадре своей анимации. Отрицательный кадр не доказывает окончание хода.

## Корень

`src/agent/claude/pane.ts` сводит мгновенный pane capture к двум значениям: spinner regex совпал —
`working`, не совпал — `idle`. Затем `src/commands/list.ts` вызывает
`resolveLiveState(scan.state === "working", scan.ready, lifecycle?.state)`, а
`src/agent/sessionStatus.ts` считает любой `ready && !paneWorking` решающим `idle` и сразу
перекрывает lifecycle `working`.

Это правило было правильным для доказанно отрисованного idle pane после Escape, но оно приравняло
два разных наблюдения:

- composer действительно устойчиво idle;
- один промежуточный кадр анимации не содержит spinner text.

Один capture не умеет различать их, поэтому boolean `paneWorking` недостаточен для отрицательного
перехода. В коде уже существует temporal evidence: daemon наблюдает pane каждые несколько секунд
и сохраняет последний доказанный working instant в `pane-activity.json`. `list` этот факт при
разрешении состояния сейчас не использует.

## Требуемая модель

- Положительный live marker остаётся немедленным доказательством `working`.
- Его отсутствие в одном capture — `indeterminate`, а не доказательство `idle`, пока lifecycle
  говорит `working` и недавнее pane activity подтверждает тот же ход.
- Переход в `idle` принимается только по устойчивому/структурному доказательству окончания,
  сохраняя существующий bounded путь для voluntary Stop и человеческого interrupt.
- Источник решает это один раз; `list`, `fleet`, `wait`, event observer и внешние consumers не
  заводят собственные debounce/LKG вокруг ложного snapshot.

Конкретная форма API на усмотрение владельца. Важно не сделать time grace новым источником истины:
он страхует отрицательный кадр, а настоящее завершение по lifecycle/turn evidence должно закрывать
ход без ожидания произвольного долгого timeout.

## План

- [x] Представить результат pane scan так, чтобы `working`, доказанный `idle` и промежуточный
      отрицательный кадр не схлопывались в один boolean.
- [x] Разрешать live state с учётом последнего доказанного pane activity и lifecycle текущего хода.
- [x] Сохранить быстрый выход в idle после реального `Stop` и bounded закрытие interrupt без `Stop`.
- [x] Провести одну и ту же модель через snapshot, wait/delivery и daemon observation либо явно
      доказать, почему их отрицательные решения различаются.
- [x] Добавить regression на последовательность реальных кадров spinner-present → spinner-absent →
      spinner-present внутри одного хода.
- [x] Обновить архитектуру session state и CHANGELOG.

## Acceptance

- [x] Идущий Claude turn, снятый чаще полного цикла spinner-анимации, ни разу не выходит как `idle`
      в `list --json` или `fleet --json`.
- [x] Тест падает на текущей реализации именно на промежуточном `ready=true` кадре без spinner и
      проходит после исправления; «всегда working» не проходит обратные проверки.
- [x] Добровольно завершённый ход становится `idle`; прерванный человеком ход также становится
      `idle` по bounded evidence и не зависает working навсегда.
- [x] `turnStartedAt` не исчезает и не начинается заново внутри одного непрерывного хода.
- [x] Живой probe на установленном release — postcondition release conveyor; evidence записывается
      в итоговый release-result после обязательного порядка `done → commit → deploy`.
- [x] Release-result содержит версию, зелёные tests/typecheck и живое доказательство до/после —
      обязательный внешний результат того же release conveyor, не mutable запись в `done/`.

## Что сделано

- [x] Provider contract: `PaneScan.state` различает `working`, `idle` и `indeterminate`;
      Claude frame без положительного marker больше не объявляет idle (`src/agent/index.ts`,
      `src/agent/claude/pane.ts`).
- [x] Snapshot: `list` разрешает отрицательный frame через lifecycle-scoped `turnState`, последнее
      pane activity и transcript activity; `fleet` переносит уже разрешённый state
      (`src/commands/list.ts`, `src/agent/sessionStatus.ts`).
- [x] Общая модель: `wait`, deferred delivery и daemon observation используют activity только
      текущего lifecycle turn; старый assistant text не закрывает новый ход
      (`src/chat/turnState.ts`, `src/chat/deliver.ts`, `src/events/observe.ts`).
- [x] Regression: исходная реализация дала `working → idle → working` на реальной тройке кадров;
      после правки focused suite зелёный, полный `bun run check` — 653 tests, 0 fail
      (`test/session-status.test.ts`, `test/pane-ready.test.ts`, `test/session-events.test.ts`).
- [x] Live source A/B на одном непрерывном Claude turn: установленный 0.39.0 дал 11 ложных `idle`
      из 30 чтений и терял `turnStartedAt`; новый path дал 30/30 `working` с одним неизменным
      instant. Source `fleet --json` сохранил все текущие working rows.
- [x] Текущая архитектура и release notes обновлены (`docs/architecture/session-events.md`,
      `CHANGELOG.md`).
