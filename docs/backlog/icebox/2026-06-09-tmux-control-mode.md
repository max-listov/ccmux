---
title: Перевести tmux-слой на control mode (-CC)
description: Драйвить tmux одним постоянным соединением (control mode) с push-событиями вместо спавна процессов на команду + поллинга capture-pane/list-sessions
type: task
status: icebox
created: 2026-06-09
updated: 2026-06-11
defrost: флот вырос (>20 сессий на машину, форки/поллинг стали заметны) ИЛИ взяли web-терминал (Фаза 6 live-клиента — xterm.js нужен %output-стрим)
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## Идея
Сейчас tmux-слой = отдельный процесс `tmux` на КАЖДУЮ операцию (send-keys/capture-pane/
list-sessions/has-session…), а «live» = поллинг `capture-pane` (1.5с в TUI) + `list-sessions`
(30с в демоне). **tmux control mode (`-CC`)** — программный протокол tmux: ОДНО долгоживущее
соединение, команды текстом, поток `%`-событий (`%output`, `%session-changed`, `%exit`…).
Так iTerm2 рулит tmux. Это «tmux как внутренний API», без замены tmux.

## Что даёт
- **PUSH вместо POLL:** `%output <pane> <data>` живьём → статус/токены/последнее сообщение
  обновляются мгновенно по событию, а не раз в 1.5с. TUI становится event-driven.
- **Смерть/рождение сессий — событием** (`%session-changed`/`%window-close`/`%exit`) →
  ensure/heal реагирует сразу, не раз в 30с поллингом.
- **Одно соединение вместо сотен спавнов** `tmux` → ниже оверхед/латентность/CPU на флоте.
- **Структурный протокол** (`%begin/%end/%error`) → чистый парс ответов, меньше grep-скрейпа.
- **Единый источник правды** — in-memory модель флота, обновляемая событиями.

## Цена / риски
- Новый модуль: **клиент control-протокола** (парс `%`-строк, reconnect при рестарте сервера,
  **flow-control** `%pause`/continue — claude может спамить выводом).
- Кто держит соединение: TUI (для live-статуса) и/или демон (для ensure) — решить.
- **Attach-хендофф НЕ меняется** (`tmux attach`/`switch-client` остаётся) — control mode про
  драйв/мониторинг, не про передачу терминала.
- Гоча `-CC`: исторически хотел controlling terminal (tmux issue #3085) — проверить под демон.
- Объём: недели, не дни. Но бьёт прямо в ядро (live-флот).

## Скетч плана (когда возьмём)
- [ ] `src/tmux/control.ts` — клиент: спавн `tmux -CC`, парс `%`-протокола, очередь команд → `%begin/%end`, события → emitter
- [ ] Reconnect + flow-control (`%pause`/`%continue`)
- [ ] Перевести live-статус TUI с поллинга `capture-pane` на `%output`-поток (pane-скрейп остаётся, но кормится событиями)
- [ ] ensure/heal: реагировать на `%session-changed`/`%exit` (поллинг — фолбэк)
- [ ] Оставить process-вызовы как фолбэк/для не-control-операций (attach)

## Ссылки
- tmux Control Mode: github.com/tmux/tmux/wiki/Control-Mode
- libtmux (Python, образец API над tmux): github.com/tmux-python/libtmux
