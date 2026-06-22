---
title: ccmux — раскатка на серверы
description: Перенести Bun-версию на серверы (systemd), заменив прежнюю реализацию с сохранением uuid'ов сессий
type: task
status: planned
created: 2026-06-09
updated: 2026-06-09
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## Контекст
Локально Bun-ccmux уже боевой (демон `com.ccmux.daemon`, бандл `~/.ccmux/app/ccmux.js`, сессии
мигрированы с сохранением uuid, bash отставлен). Осталось повторить на серверах.

## План
- [ ] dev-сервер: собрать/доставить бандл, `ccmux install --rc-prefix dev` (systemd `ccmux.service`)
- [ ] prod-сервер: то же, `--rc-prefix prod`
- [ ] **Сохранить uuid'ы** боевых сессий: cc-app / -staging и др. — выписать ПОЛНЫЙ список ДО замены
- [ ] Dev-изоляция на время сосуществования (отдельный boot-label / sessions-file), чтобы не драться с живым bash-демоном (тот же класс бага, что был локально — реестр делить нельзя)
- [ ] Прогнать миграцию каждой сессии под наш `_run` (resume по uuid, контекст цел)
- [ ] Похоронить bash-ccmux после подтверждения
- [ ] Проверить fish-aware login-PATH на сервере (loginShellPath портирован — но шеллы выровнены на POSIX-login, перепроверить)

## Acceptance
- [ ] Раскатано на dev-сервер + prod-сервер, uuid'ы сохранены, bash выведен, сессии переживают ребут
