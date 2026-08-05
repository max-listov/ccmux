---
title: ccmux — раскатка на серверы
description: Перенести Bun-версию на серверы (systemd), заменив прежнюю реализацию с сохранением uuid'ов сессий
type: task
status: done
created: 2026-06-09
updated: 2026-07-30
completed: 2026-07-30 08:40 +07:00
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## Контекст
Локально Bun-ccmux уже боевой (демон `com.ccmux.daemon`, бандл `~/.ccmux/app/ccmux.js`, сессии
мигрированы с сохранением uuid, bash отставлен). Осталось повторить на серверах.

## План
- [x] dev-сервер: `ccmux.service` (systemd), rcPrefix dev — активен.
- [x] prod-сервер: `ccmux.service`, rcPrefix prod — активен.
- [x] uuid'ы боевых сессий сохранены (fix-uuid pin, resume по uuid — беседы целы).
- [x] Dev-изоляция обеспечена (свой sessions-file/boot-label per-machine).
- [x] Миграция каждой сессии под `_run` (resume по uuid) — сессии переживают ребут.
- [x] bash-ccmux выведен на обоих серверах (мёртвые пути в allowlist — под чистку по мере встречи).
- [x] fish-aware login-PATH: шеллы выровнены на POSIX-login, голые ssh-команды работают.

## Acceptance
- [x] Раскатано на dev+prod, uuid сохранены, bash выведен, сессии переживают ребут.

## Что сделано

Раскатка выполнена ранее и **валидирована по живому состоянию** в этой итерации:
- `ssh host-b 'systemctl is-active ccmux.service'` → **active** (7 сессий).
- `ssh host-c 'systemctl is-active ccmux.service'` → **active** (6 сессий).
- Оба узла: один демон на машину (systemd), self-heal, resume по фикс-uuid, bash-реализация
  выведена (канон — `servers-and-projects.md`).

**Что НЕ делалось:** чистка мёртвых `Bash(/home/*/ccmux:*)` allowlist-паттернов — точечно по мере
встречи (одноразовая гигиена, не блокер).
