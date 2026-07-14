---
title: Follow the fork — реестр догоняет форкнутую беседу
description: Claude Code форкает беседу на новый session id (out-of-context) — ccmux должен детектить переезд и перепривязывать uuid в реестре
type: task
status: done
created: 2026-07-14
updated: 2026-07-14
completed: 2026-07-14 14:16 +08:00
---

# Follow the fork

## Контекст / инцидент

2026-07-14: карточка одной managed-сессии зависла на сообщении трёхдневной давности, живая
беседа дублировалась в external. Разбор показал: Claude Code (v2.1.208) при переполнении
контекста форкнул беседу `e8f056d3 → 711f8574` (новый jsonl, скопированный хвост,
`custom-title` унаследован, исполнение под `bg-pty-host`-демоном Claude), а argv процесса
в пейне остался `--resume e8f056d3`. Реестр ccmux никто не догонял → все jsonl-производные
данные протухли, рестарт резюмил бы мёртвую беседу. Ресёрч по нативным средствам CC
(Agent View / bg sessions) подтвердил: ребут-персистентность и флот CC не покрывает,
ccmux актуален — но обязан уметь форки новой демон-архитектуры CC.

## План

- [x] Механизм детекта форка без предположений о триггере — по собственному ключу ccmux
      (`custom-title == rcName` в head + новейший message-timestamp) — `src/agent/claude/fork.ts`
- [x] Хук в контракте провайдера (`AgentProvider.detectFork`, опциональный) + generic
      `forkedUuid` — `src/agent/index.ts`
- [x] Атомарная перепривязка реестра — `updateSessionUuid` в `src/config/sessions.ts`
- [x] Интеграция в heal-пасс демона ДО решения о старте — `src/commands/ensure.ts`
      (демон = единственный писатель; TUI подхватывает на следующем полле)
- [x] Перф-гвард 30с-тика: stat-префильтр по mtime вместо чтения всех транскриптов
- [x] Вынос байтовых читалок head/tail в `src/util/readLines.ts` (дедуп agent/index +
      tui/discover, нужны форк-детекту без циклов импортов)
- [x] External-дискавери: pane-фильтр `externalResumingUuids` (`writers.ts` + `discover.ts`) —
      после форка старый uuid из argv пейна больше не всплывает «живым» external-дублем
- [x] Тесты: `test/fork.test.ts` (9 кейсов) + `test/ensure.test.ts` (follow на каждом пассе)
      + `test/writers.test.ts` (pane-фильтр, зеркалит реальное дерево процессов инцидента)
- [x] Доки: `docs/architecture/follow-the-fork.md` + README «How it works»
- [x] Вылечить живое расхождение самим механизмом (одиночный прогон `ensure` на dev-коде):
      реестр перепривязан на форк `711f8574`, превью/данные ожили, ложных
      срабатываний на остальных сессиях нет
- [x] Деплой: релиз v0.1.7 опубликован (GitHub Releases, 2026-07-14 ~13:00 +08:00),
      весь флот обновился АВТО-апдейтом без рук за ~5.5 мин; follow-fork код проверен
      grep'ом в живых бандлах всех машин, сессии пережили bounce, логи демонов чистые
      («auto-update seen 0.1.6→0.1.7», boot-guard не ревертил)

## Что сделано

- **Agent/claude:** `src/agent/claude/fork.ts` — detectFork + lastMessageMs (гварды: чужие
  pin'ы, титул в head, строгая новизна, stat-префильтр); провайдер подключён в
  `src/agent/claude/index.ts`
- **Core:** `src/agent/index.ts` — хук контракта + `forkedUuid`; `src/config/sessions.ts` —
  `updateSessionUuid`; `src/commands/ensure.ts` — follow-fork в каждом heal-пассе
- **Util:** `src/util/readLines.ts` — readLines/readTailLines/readHeadLines (перенос из
  agent/index.ts и tui/discover.ts, все callsites переписаны)
- **Тесты:** `test/fork.test.ts`, `test/ensure.test.ts`, `test/tailread.test.ts` (импорт) —
  весь сьют 87 pass, tsc чистый
- **Доки:** `docs/architecture/follow-the-fork.md`, README «How it works» (пункт Follow the fork)
- **Не делалось:** деплой/версия/рестарт прод-демона (гейт проекта — ждёт явного «го»)
