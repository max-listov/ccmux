---
title: ccmux — v1 polish (auto-update, completions, help, git/releases)
description: Мелочи v1 — daemon авто-проверка апдейтов, shell-completions, help/usage, git remote + Releases для remote self-update
type: task
status: planned
created: 2026-06-09
updated: 2026-06-11
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## План
- [x] Daemon авто-проверка апдейтов по таймеру — сделано чище плана: `autoUpdateOnce()` в демон-тике (`daemon.ts:37-40`, throttle `updateCheckInterval`, gate `autoUpdate`), sha256-verify до свапа, atomic swap + bounce (`update.ts:112-144`); `update --check` тоже есть (`update.ts:95`)
- [ ] shell-completions (zsh/bash/fish) — папка `completions/` уже есть, доработать
- [x] `ccmux help` / per-command usage причесать — 2026-06-11: добавлены `transcript`/`doctor`/`build`/`release`/`tui` в COMMANDS (`help.ts`), баг `transcript --help`→«unknown command» убит корнево: `HELP_VERBS` теперь выводится из `COMMANDS` (`cli.ts`), дрейф двух списков невозможен
- [ ] git remote + Releases-манифест (releaseUrl + sha256) — для REMOTE self-update (local-staged уже работает)
- [ ] README/доки актуализировать под Bun-версию + dev/prod/update флоу

## Acceptance
- [ ] Демон сам замечает апдейт; completions работают; remote-update через Releases доступен
