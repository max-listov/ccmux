---
title: Изолированный dev-инстанс ccmux (tmux-socket + CCMUX_HOME) — DevPattern
description: Поднять рядом с боевым ccmux ПОЛНОЦЕННЫЙ второй инстанс (демон + сессии + чат) на той же машине, полностью изолированный от прода — свой tmux-сервер, свой реестр/чат/лог/boot-state — чтобы тестировать фичи локально, без прод-демона и без серверов
type: task
status: done
created: 2026-07-19
updated: 2026-07-19
completed: 2026-07-19 15:06 +08:00
related: docs/architecture/tui-and-dev-flow.md
---

## Зачем
Тестировать новую фичу (напр. inter-agent chat) на РЕАЛЬНОМ ccmux — демон + живые claude-сессии +
доставка — нужно **не трогая боевой флот**. Хочется: рядом с прод-ccmux на том же компе поднять
второй, **полностью изолированный** инстанс из ИСХОДНИКА, погонять, снести. Без прод-демона, без
DEV/PROD-серверов.

## Блокер, который это вскрыл (проверено 2026-07-19)
Наивный «второй инстанс через `CCMUX_CONFIG`/`CCMUX_SESSIONS`» **не работает**: `_run` в tmux-пейне
читает `CCMUX_CONFIG` из env, а **tmux НЕ пропагирует произвольные env-переменные** в новые сессии
(только свой server-env). Итог: пейн уходит в ПРОД-конфиг → не находит dev-сессию → умирает.
Прод работает лишь потому, что использует дефолтные пути (env не нужен). Подтверждено: dev-сессия
умерла сразу, `tmux show-environment` — без `CCMUX_*`.

## Решение (чисто, масштабируемо)
**Изоляция на уровне tmux-СОКЕТА + CCMUX_HOME.** Два добавления в ccmux:

1. **`tmuxSocket` (опц.) в MachineConfig.** Задан → ВСЕ вызовы tmux идут через `-L <socket>`.
   Не задан → текущее поведение (дефолтный сокет = прод). Ключевой эффект: dev-инстанс получает
   **СВОЙ tmux-сервер**, который **наследует env стартующего процесса** (демона с `CCMUX_CONFIG`)
   при первом запуске → `_run`-пейны на этом сокете видят dev-конфиг. Env-проблема решена в корне.
2. **`CCMUX_HOME` — env-оверрайд** в `paths.ts` (`process.env.CCMUX_HOME ?? ~/.ccmux`). Изолирует
   app/staged/boot-attempts/log dev-инстанса в `~/.ccmux-dev/` — не делит boot-guard/лог с продом.

Всё остальное уже изолируемо: `CCMUX_CONFIG` (конфиг), `sessionsFile` (реестр), чат-стор (деривится
из папки реестра), `rcPrefix` (RC-имена `dev-*` vs прод `m5-*`).

## DevPattern (как поднимать — итоговая процедура)
Скрипт-хелпер (`scripts/dev-instance.sh` или `bun run dev:up`) скаффолдит `~/.ccmux-dev/` (machine.json
с `tmuxSocket:"ccmux-dev"`, свой sessionsFile, rcPrefix `dev`) и печатает env-экспорты. Дальше:
```
export CCMUX_HOME=~/.ccmux-dev CCMUX_CONFIG=~/.ccmux-dev/machine.json
bun run src/cli.ts new dev-a <dir>;  new dev-b <dir>     # реальные claude на сокете ccmux-dev
bun run src/cli.ts chat on dev-a;    chat on dev-b
bun run daemon:watch                                      # dev-демон из ИСХОДНИКА с hot-reload
                                                          #   (= bun --watch src/cli.ts daemon:
                                                          #    правка исходника → чистый рестарт
                                                          #    процесса, свежие таймеры; НЕ --hot —
                                                          #    тот множил бы ensure/chat-петли.
                                                          #    boot-guard из dev пропущен, IS_DEV)
bun run src/cli.ts msg dev-b "hi" --from dev-a            # → доставка в пейн dev-b за ~3с
tmux -L ccmux-dev attach -t dev-b                         # посмотреть глазами
# снос: kill dev-демон · tmux -L ccmux-dev kill-server · rm -rf ~/.ccmux-dev
```
Прод (`com.ccmux.daemon` на дефолтном сокете) не тронут: другой сокет, другой CCMUX_HOME, другой реестр.

## Acceptance
- [x] `tmuxSocket` в схеме; все tmux-вызовы через socket-aware хелпер `tmuxArgv` (+ TUI-attach в
      `run.tsx`, paste-buffer) — `src/tmux/tmux.ts`, `src/config/schema.ts`.
- [x] `CCMUX_HOME` env-оверрайд в `paths.ts`.
- [x] Юнит-тест socket-хелпера — `test/tmux-socket.test.ts` (задан → `-L`, не задан → без).
- [x] E2e прогнан вживую: dev-инстанс на сокете `ccmux-dev`, 2 реальные claude-сессии читают
      dev-конфиг (через `new-session -e` проброс env), `msg` доставляется в пейн, каскад
      cli→dev-a→dev-b→owner отработал, прод-флот не тронут.
- [x] `bun run check` зелёный (120/0).
- [x] DevPattern записан в `tui-and-dev-flow.md` (секция Hot-reload/dev-daemon).
- [x] Хелпер-скрипт `scripts/dev-instance.sh` (scaffold + `--env` + `--down`).
- [x] Бонус (урок из инцидента 2026-07-19): **RC-off для dev** — `remoteControl:false` в конфиге →
      launch добавляет `--settings disableRemoteControl` → dev-сессии не светятся в claude.ai-аппе
      (иначе путаются с боевыми — владелец случайно переключился в dev-сессию). `src/config/schema.ts`,
      `src/agent/claude/launch.ts`.

## Что сделано
- **Config** (`src/config/schema.ts`): `tmuxSocket?`, `remoteControl` (деф. true).
- **paths** (`src/config/paths.ts`): `CCMUX_HOME = process.env.CCMUX_HOME ?? ~/.ccmux`.
- **tmux** (`src/tmux/tmux.ts`): `tmuxArgv(m,…)` — все вызовы через `-L <socket>`; `new-session -e`
  пробрасывает `CCMUX_HOME/CONFIG/SESSIONS` в пейн (env через tmux сам не летит — корневой блокер);
  `pasteText` тоже через сокет.
- **TUI** (`src/tui/run.tsx`): attach через `tmuxArgv`.
- **env** (`src/env.ts`): `promptInvocation` при non-default `CCMUX_HOME` учит source-cli (не прод-шим).
- **launch** (`src/agent/claude/launch.ts`): `remoteControl:false` → `--settings disableRemoteControl`.
- **Хелпер** (`scripts/dev-instance.sh`), **тест** (`test/tmux-socket.test.ts`), **доки**
  (`tui-and-dev-flow.md`, `package.json daemon:watch`).
- **НЕ делалось:** `ccmux dev`-подкоманд (скрипт достаточно), кросс-машинный dev.

## Не в этой задаче
- Полноценный `ccmux dev`-подкоманд (пока скрипт/док-процедура довольно).
- Кросс-машинный dev (это про Stage 4 чата, отдельно).
