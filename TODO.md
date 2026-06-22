# ccmux — TODO

## ❌ Killed ideas (не возвращать)

- **`tile` (read-only capture-pane зеркало) — УДАЛЁН. BAD IDEA.**
  Read-only → нельзя печатать в сессии → для реальной работы бесполезно. «Глянуть» и так
  закрывается VS Code split'ом. Не реинтродьюсить. (был `src/commands/tile.ts`, снят).

## 🎯 Хочу дальше: интерактивный pane-режим (`ccmux panes`)

Суть: видеть N агентов рядом **И печатать в каждого**, одной командой. Интерактив, не зеркало.

Дизайн (отложен, не делать пока не скажу):
- `ccmux panes cc-a cc-b` → одно окно tmux, по панели на агента, в каждой `ccmux _run cc-X`
  → **реальный живой claude в панели** (resume по uuid, интерактив). Как руками, но автоматом.
- Жёсткое ограничение: один uuid нельзя запустить дважды → агент ЛИБО отдельная сессия,
  ЛИБО член pane-группы. `panes` сначала стопает их standalone-сессии.
- Маркер `~/.config/ccmux/groups.json` = `{window: [names]}` — чтобы демон не запускал
  сгруппированных агентов ВТОРОЙ раз (standalone + панель = дубль uuid).
- Heal: conversation-level бесплатно (per-pane `_run`); pane/window-level — демон
  пере-сплитит/пересоздаёт окно из маркера.
- Файлы: `commands/panes.ts` (+ungroup), `config/groups.ts`, правки `ensure.ts`, cli, тесты.

`tile` (смотреть) vs `panes` (работать вживую) — разные инструменты. tile убран, остаётся panes.

## 🔒 Запреты / guards

- [x] self-rm/stop guard — нельзя снести/стопнуть сессию из которой зовёшь (`refusesSelf` + `--force`).
- [ ] решить: подтверждение на `rm` чужой сессии (или оставить как есть)?
- [ ] решить: остальные запреты — TBD.

## ✅ v1 — доделать

- [ ] `ccmux update` (self-update: releaseUrl + sha256 verify + bounce демона) + `version` notes
- [ ] shell-completions (zsh/bash/fish)
- [ ] нормальный `ccmux help` / per-command usage (агент с первого раза дёрнул `start --dir` — не угадал)
- [ ] `list` с колонкой uptime / когда создана
- [ ] триггер `new <name> <dir>` в инжектируемый промпт (агент промахнулся первой попыткой)
- [ ] README (+ опц. `~/.tmux.conf`: `extended-keys`/`terminal-features` для Shift+Enter на голых
      терминалах — в VS Code и так работает), LICENSE (MIT), `.github/workflows` CI (bun test + per-arch build)
- [ ] первый git-коммит (репо до сих пор без коммитов)

## 🚀 Раскатка (после доделки v1)

- [ ] финал на local → dev-сервер (systemd) → prod-сервер (заменить прежнюю реализацию, сохранить uuid'ы сессий)
- [ ] (опц.) выделенный tmux-сокет `-L ccmux` для полной изоляции от ручного tmux + `ccmux attach`
