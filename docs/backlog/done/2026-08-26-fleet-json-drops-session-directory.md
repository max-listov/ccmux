---
title: Fleet JSON drops session directory
description: Preserve each managed session's declared directory across fleet fan-out so consumers can join sessions to their own canonical project catalogues without name heuristics.
type: task
status: done
tags: [fleet, sessions, json, identity]
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 11:50 +07:00
---

# Fleet JSON drops session directory

## Зачем

`ccmux list --json` reports the declared `dir` of every managed session. `ccmux fleet --json`
fetches that document from every peer, but its tolerant remote schema and local projection rebuild
session rows without `dir`. A fleet consumer therefore knows the canonical session address and
provider, but loses the only factual checkout identity and has to guess from a session name.

The fleet layer should transport this owner fact, not interpret it as a project. Project identity
belongs to the consuming catalogue; ccmux only needs to preserve the declared directory.

## Результат

- Fleet session JSON includes `dir: string | null` for local and remote peers.
- A peer that predates the field remains readable and produces `dir: null`, not a failed machine.
- Human `ccmux fleet` output does not need a new column; the field is a structured identity anchor.
- The published JSON schema/types and command documentation name the field and its compatibility
  semantics.

## Acceptance

- [x] Local fleet rows preserve the exact directory already returned by `ccmux list --json`.
- [x] Remote rows preserve the same field without normalizing, shortening or inferring it.
- [x] Missing `dir` from an older peer becomes `null` while its other sessions remain visible.
- [x] Tests cover local, current remote and older remote payloads.

## Что сделано

- [x] `RemoteSessionSchema` в `src/commands/fleetList.ts` получил `dir: string | null`, локальная
      проекция отдаёт `r.session.dir`. Человеческий вывод не тронут — поле структурное.
- [x] Строка переносится **без интерпретации**: потребитель сопоставляет по самому длинному
      префиксу пути, поэтому укорачивание, разрешение симлинка или срез хвостового слэша молча
      меняют, к какому проекту она подойдёт. ccmux знает, что сессия объявила; что этот каталог
      ЗНАЧИТ — дело того, кто ведёт каталог проектов.
- [x] `test/fleet-dir.test.ts`, 4 проверки: локальная строка совпадает с `list --json` побайтово;
      хвостовой слэш, `..`, кириллица и пробел проходят неизменёнными; пир без поля даёт `null`, а
      его остальные сессии видны; поле проходит через `fleetView` нетронутым. 646 тестов зелёные.

## Что оказалось лучше, чем предполагала задача

Совместимость шире заявленной. `dir` присутствует в `list --json` давно, поэтому **удалённые
строки поехали сразу**, без ожидания раскатки на пиров: терялось поле только в проекции fleet.
Проверено на живом флоте до выпуска — `dev` и `prod` отдали настоящие каталоги, будучи на прежней
версии. Обновление нужно только той машине, с которой зовут `fleet`.

`dir: null` поэтому означает пира, чей `list --json` предшествует появлению поля вообще — случай
куда более давний, чем «не обновился». Поле оставлено nullable именно для него.
