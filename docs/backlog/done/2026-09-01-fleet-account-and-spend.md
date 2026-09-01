---
title: Which session is spending whose account
description: Nothing in the fleet answers which account a session runs on or what it has spent; a subscription limit is discovered by hitting it.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:46 +0700
pipeline: native-parity
order: 4
depends-on: —
---

# Аккаунт и расход по флоту

## Зачем

Cost appears in exactly one place — `src/commands/statusLine.ts` reads `total_cost_usd` for the
session that emitted the statusline — and account identity appears nowhere at all. Across several
machines running many sessions, the first sign that one of them exhausted a limit is that it stops
working, and the operator then has no way to ask which sessions share that account.

A native runtime can be asked directly: `Query.accountInfo()` names the account a session is
running on.

## Результат

- Each session's snapshot carries the account it runs on, for the runtimes that can report one.
- Spend and account are visible in the fleet slice, not only for a session on this machine.
- An operator can answer "which sessions share this account" without opening each one.

## План

- [x] Read account identity in the native owner and publish it in the snapshot.
- [x] Carry account and spend through the fleet projection.
- [x] Group by account where the fleet is listed.

## Границы

An account identifier is not a credential and no token, key or session cookie may reach a snapshot,
a receipt or a log. This repository is public: fixtures and tests use placeholders.

## Acceptance

- [x] Живая проверка: сессия сообщает свой аккаунт, и он совпадает с тем, под которым она работает.
- [x] В выводе флота видно, какие сессии делят один аккаунт.
- [x] Ни один секрет не попадает в snapshot, receipt или лог.

## Что сделано

### Runtime

- [x] `src/agent/claude/native/account.ts`: проекция ответа runtime в `label` / `organization` /
      `subscription` / `provider`. `tokenSource` и `apiKeySource` **не читаются**: они называют,
      ГДЕ живут учётные данные — шаг к ним, и на вопрос «кто тратит» не отвечают.
- [x] Спрашивается один раз при старте: ответ не меняется, пока сессия жива. Runtime, который
      ничего не сказал, не публикует ничего — аккаунт, который никто не назвал, это не аккаунт с
      неизвестным именем.
- [x] Расход берётся из того, что runtime сам называет в результате хода, и никогда не выводится
      из числа токенов.

### Флот

- [x] `account` и `costUsd` в строке `list`, в `ListItemSchema` и в `RemoteSessionSchema`.
      Ограничение принадлежит аккаунту, а не машине, поэтому единственное место, где вопрос
      «какие сессии делят этот аккаунт» вообще отвечается, — срез по всем машинам.
- [x] `accountLines` печатает по строке на аккаунт с суммой и списком сессий. Неизмеренная сумма
      пишется как `cost unknown`, а не как ноль: ноль — утверждение, что сессии ничего не стоили.
      Аккаунт, который никто не назвал, не печатается: молчание — не группа.

### Тесты

- [x] `test/fleet-accounts.test.ts`: состав полей аккаунта (и отсутствие лишних), метка по
      организации при отсутствии почты, «ничего не сказано» ≠ «нет аккаунта», группировка по
      машинам с суммой, неизмеренная сумма, отсутствие групп при молчании.

### Живая проверка

- [x] Сессия сообщила свой аккаунт: подписка `Claude Max`, провайдер `firstParty`, организация
      присутствует (значения в отчёте замаскированы намеренно).
- [x] Расход после хода: `0.049699` USD, с отметкой наблюдения.
- [x] Поля дошли до строки `list` и до группировки флота.
- [x] Ни токен, ни ключ, ни источник учётных данных в snapshot, receipt или лог не попадают.
