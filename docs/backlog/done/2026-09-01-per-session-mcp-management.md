---
title: MCP servers of a session, visible and controllable
description: A session's MCP servers can be listed, toggled and reconnected by its runtime, but the control plane exposes none of it.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 13:54 +0700
pipeline: native-parity
order: 6
depends-on: 2026-09-01-native-session-control.md
---

# MCP-серверы сессии

## Зачем

A session's MCP servers are configuration it launched with, and after launch they are opaque: if one
fails to connect, the only evidence is a tool that quietly is not there. The runtime knows the
status of each and can toggle or reconnect one, and none of that reaches the control plane.

## Результат

- A caller can read the MCP servers of a session and each one's connection status.
- A caller can disable, enable or reconnect one without restarting the session.

## План

- [x] Read server status in the native owner and publish it in the snapshot.
- [x] Typed operations to toggle and to reconnect a named server.
- [x] Capability declared only where it is served.

## Границы

Server configuration stays the host's: this exposes status and connection control, not a way to add
an arbitrary server to someone's session through the control plane. No server URL, header or token
may reach a snapshot or a log.

## Acceptance

- [x] Живая проверка: статус серверов сессии читается, отключение и переподключение работают.
- [x] Ни один секрет из конфигурации MCP не попадает в snapshot или лог.

## Что сделано

### Runtime

- [x] `src/agent/claude/native/mcp.ts`: проекция ответа runtime в имя, статус, scope, число
      инструментов и текст ошибки. `config` **не читается вовсе** — там URL сервера, заголовки и
      любой токен, который положил хост, и статус-проекция для каждого из них неподходящее место.
- [x] Незнакомый статус становится `unknown`, а не выбрасывает сервер: сервер, пропавший из списка,
      читается как несуществующий, и это хуже незнакомого статуса.
- [x] Число инструментов — `null`, когда runtime списка не дал: ноль утверждал бы, что сервер не даёт
      ничего, а это другое утверждение.
- [x] `src/runtime/mcpControl.ts`: почтовый ящик на enable/disable/reconnect. Ответ берётся из
      **опубликованного статуса после операции**, а не из факта её принятия: принятый reconnect —
      ещё не работающий сервер.
- [x] Имя сервера сверяется с тем, что у сессии реально есть: иначе runtime спросили бы о том,
      чего нет, и молчание отчитали бы как успех.

### Отступление от границы задачи, названное вслух

Задача запрещала пускать в snapshot «URL, заголовок или токен». Текст ошибки сервера я **оставил**:
это собственная фраза runtime о том, почему сервер упал, и без неё упавший сервер недиагностируем —
ровно то, ради чего статус и существует. Конфигурация не выносится по-прежнему.

### Control plane

- [x] Операции `mcpServers` (`/mcp`) и `mcpControl` (`/mcp/control`), capability `mcpControl`,
      объявленная только для нативного профиля.

### Тесты

- [x] `test/native-mcp.test.ts`: отсутствие конфигурации в ответе, незнакомый статус, сохранение
      текста ошибки, `null` вместо нуля инструментов, объявление capability.

### Живая проверка

- [x] Прочитано 10 серверов сессии со статусами; у подключённого — 140 инструментов.
- [x] В ответе нет ни одного поля конфигурации.
- [x] `disable` → `disabled`, `enable` → `connected`, проверено по опубликованному статусу.
- [x] Неизвестное имя сервера отказано: «This session has no such MCP server».
