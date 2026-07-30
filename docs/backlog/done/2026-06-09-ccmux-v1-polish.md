---
title: ccmux — v1 polish (auto-update, completions, help, git/releases)
description: Мелочи v1 — daemon авто-проверка апдейтов, shell-completions, help/usage, git remote + Releases для remote self-update
type: task
status: done
created: 2026-06-09
updated: 2026-07-30
completed: 2026-07-30 08:40 +07:00
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## План
- [x] Daemon авто-проверка апдейтов по таймеру — сделано чище плана: `autoUpdateOnce()` в демон-тике (`daemon.ts:37-40`, throttle `updateCheckInterval`, gate `autoUpdate`), sha256-verify до свапа, atomic swap + bounce (`update.ts:112-144`); `update --check` тоже есть (`update.ts:95`)
- [x] shell-completions (zsh/bash/fish) — 2026-07-30: `ccmux completions <shell>` (`src/commands/completions.ts`), генерится ИЗ реестра `COMMANDS` (single source, не дрейфует), README + тест
- [x] `ccmux help` / per-command usage причесать — 2026-06-11: добавлены `transcript`/`doctor`/`build`/`release`/`tui` в COMMANDS (`help.ts`), баг `transcript --help`→«unknown command» убит корнево: `HELP_VERBS` теперь выводится из `COMMANDS` (`cli.ts`), дрейф двух списков невозможен
- [x] git remote + Releases-манифест (releaseUrl + sha256) — REMOTE self-update РАБОТАЕТ: `update.ts` fetchRelease+checksum+`autoUpdateOnce`, CI публикует versioned asset+manifest (`release.ts --ci-assets`); за последние сессии флот подтянул несколько релизов через это.
- [x] README актуализирован под Bun (daemon/self-update/dev-prod/doctor/completions — 216 строк).

## Acceptance
- [x] Демон сам замечает апдейт (`autoUpdateOnce`); completions работают (`ccmux completions <shell>`); remote-update через Releases доступен (releaseUrl+sha256, валидировано живыми релизами).

## Что сделано

- [x] **shell-completions** — `src/commands/completions.ts` (`completionsScript(bash|zsh|fish)` из `COMMANDS`),
  `ccmux completions <shell>` в `cli.ts`, запись в `COMMANDS`/help, строка в README, `test/completions.test.ts`.
- [x] **Остальное уже было** (валидировано по коду): auto-update (`daemon.ts`+`update.ts`),
  help/usage single-source (`help.ts`/`cli.ts`), releaseUrl+sha256 remote self-update (`update.ts`+CI), README.

**Что НЕ делалось:** статичная папка `completions/` с файлами — осознанно: генерим on-demand из
одного источника (как `codex completion`/`gh completion`), файлы бы дрейфовали от `COMMANDS`.
