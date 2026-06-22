---
title: ccmux — порт на Bun/TypeScript (замена bash-версии)
description: Перенести ccmux с bash на типизированный модульный Bun-проект со всеми функциями текущего bash v1.4.1 + live-TUI + self-update
type: task
status: done
created: 2026-06-09
updated: 2026-06-09
completed: 2026-06-09 12:47
---

## Ради чего

Один чистый `ccmux`, который:
1. `ccmux` → интерактивное меню; виден флот сессий, **токены/статус/uptime в лайве**;
   стрелками выбрал → attach; detach → назад в список; новая сессия из текущей папки.
2. Типизирован, тестируется, **сам обновляется** (без своего backend), лёгкий (~1MB + bun).
3. Заменяет bash-ccmux, **сохраняя uuid'ы** сессий.

Агент-агностик в перспективе (Claude Code сейчас, дальше — другие агентские CLI).

## Контекст / решения

- Кодовая база — бывший `restoke` (порт уже на 90% готов), переименован в `ccmux` **в этой папке**.
- прежняя bash-`ccmux` (v1.4.1) и реестр `~/.ccmux-sessions` — на
  локальной машине ЗАМЕНЁН Bun-версией (демон отставлен, бинарь как `ccmux-legacy` fallback).
  Серверы — отдельной задачей (см. server-rollout).
- **Соседний инструмент не трогаем** — отдельный проект, свой контракт, без взаимного импорта.
- Имя папки = `ccmux` (переименовано из restoke; 0 упоминаний restoke в коде/путях/сессиях).

## Этапы

### Этап 0 — старт проекта ✅
- [x] Скопирован код restoke, **полное переименование** restoke→ccmux (0 остатков)
- [x] `package.json` name/bin/build = `ccmux`; 37 тестов зелёные
- [x] docs/backlog структура заведена
- [x] Первый git-коммит → **отложено: коммит по команде владельца** (репо без коммитов by design)

### Этап 1 — паритет с bash v1.4.1 ✅
- [x] `list --json` + pane-скрейп (model / context% / working-idle) — `claude/pane.ts`, `ListJsonSchema`, live
- [x] `session_used` (context-size из transcript) — `claude/transcript.ts usedTokens`, без jq
- [x] env-override `CCMUX_RC_PREFIX`
- [x] `transcript --json` (+ `lastMessage` в list) — мульти-агентный адаптер, live 1-в-1 Claude И Codex
- [x] `logs --json` — `commands/logs.ts`
- [x] `restart --then "<note>"` + wait_ready — `lifecycle.ts`, readiness через `provider.scanPane`
- [x] `doctor [--json]` — deps + daemon, live
- [x] **Этап 1 ЗАКРЫТ** (+ мульти-агент + провайдер-абстракция сверху)

### Этап 1.5 — мульти-агентные транскрипты ✅
- [x] `Session.agent: "claude"|"codex"` (default claude, легаси валидны)
- [x] `src/agent/{claude,codex}/transcript.ts` + `normalize.ts` (type-guards, без `as`)
- [x] Codex-маппинг (developer→system, function_call→tool_call, …), токены из `token_count`
- [x] Локация per-agent (Claude uuid в projects/; Codex rollout-glob)
- [x] arch-док `docs/architecture/transcript-adapters.md`
- [x] launch/resume для `agent=codex` → **вынесено в `planned/2026-06-09-ccmux-codex-launch.md`** (чтение уже 1:1, launch — гэп)

### Этап 1.6 — провайдер-абстракция ✅
- [x] `src/agent/index.ts` — `AgentProvider` (buildArgv·launchEnv·historyFile·parse·usedTokens·scanPane) + REGISTRY
- [x] симметричные `src/agent/{claude,codex}/` (index·launch·resume·prompt·pane·transcript)
- [x] ядро провайдер-агностично (`run.ts`, `list.ts`); `codexBin` автодетект
- [x] typecheck чистый, 37 тестов, live Claude+Codex
- [x] **Сверка с bash v1.4.1**: build_prompt инъекция ✅, install launchd/systemd ✅, RC-prefix ✅,
      `=name` exact-match ✅, ensure 30s ✅, self-guard ✅, **PATH-реконструкция login-shell (fish-aware) — ПОРТИРОВАНА** (`util/envPath.ts loginShellPath`, применена в обоих launchEnv)

### Этап 2 — live-TUI ✅
- [x] inline-native по умолчанию (`ccmux`), fullscreen по флагу (`ccmux -f`), `f` переключает
- [x] правая панель — листаемый транскрипт (whole-message windowing, рамки user / планки assistant)
- [x] навигация ↑↓ · Enter attach · new/stop/restart/rm (silent actions)
- [x] live poll 1.5с (токены/статус/uptime растут), провайдер-бейджи, версия в шапке
- [x] **compose: `i` → написать сообщение в живую сессию** (send-keys), external read-only
- [x] DRY (`src/tui/` format/components/hooks; views/ только layout)
- [x] CLI не тянет Ink (lazy import); non-TTY → help
- [x] e2e интерактив → **проверено живьём на TTY** (работа в TUI: nav/attach/send/new)

### Этап 3 — bundle / self-update ✅
- [x] Сборка bundle `bun build --target=bun --external react-devtools-core` → `~/.ccmux/app/ccmux.js` (1.7МБ)
- [x] Self-update: **local-staged ПЕРВЫМ** (`ccmux build` → `ccmux update`) + remote (releaseUrl+sha256);
      atomic swap + bounce демона, сессии переживают, `--rollback`. Проверено живьём 0.0.1→0.0.2→0.0.3
- [x] Авто-проверка апдейтов по таймеру в демоне → **вынесено в `planned/2026-06-09-ccmux-v1-polish.md`**

### Этап 4 — тесты / CI ✅(вынесено)
- [x] Юниты на новые модули + `.github/workflows` → **вынесено в `planned/2026-06-09-ccmux-ci-and-tests.md`** (37 тестов уже зелёные, расширение — отдельно)

### Этап 5 — раскатка ✅(local) / вынесено(серверы)
- [x] **LOCAL раскатан**: демон `com.ccmux.daemon` (бандл), bash-демон убит + плист `.legacy`, бинарь → `ccmux-legacy`
- [x] **Замена bash локально, uuid'ы сохранены**: cc-main, client-app мигрированы под наш `_run` (resume по uuid, контекст цел)
- [x] **Dev-изоляция**: dev (`ccmux-dev`, исходник `--hot`) и prod (бандл) развязаны, ОДИН демон
- [x] Раскатка на серверы → **вынесено в `planned/2026-06-09-ccmux-server-rollout.md`**

## Acceptance
- [x] Все команды bash v1.4.1 — паритет (18/18 + `update`/`tui`/`build`); поведение сверено, PATH-гэп закрыт
- [x] `ccmux` открывает живой интерактивный TUI
- [x] `ccmux update` подтягивает новую версию (local-staged проверен; remote-Releases → v1-polish)
- [x] Раскатано **локально** (uuid'ы сохранены, bash выведен); **3 сервера → вынесено в server-rollout**

## Что сделано

**Shared / типы**
- [x] `Session.agent` Zod-enum, провайдер-агностичные контракты (`src/config/schema.ts`, `src/agent/index.ts`)
- [x] display-width слой (`src/tui/format.ts`: dispWidth/sliceToWidth/clipWidth/wrapText, sanitize стрипит ANSI/control/эмодзи)

**Backend / ядро**
- [x] Все 18 bash-команд + `update`/`tui`/`build` (`src/commands/*`, dispatch `src/cli.ts`)
- [x] Провайдер-абстракция `src/agent/{claude,codex}/` (launch/resume/prompt/pane/transcript)
- [x] Демон/ensure/_run (backoff, fork-recovery, resume по uuid) — `src/commands/{daemon,ensure,run,lifecycle}.ts`
- [x] **PATH login-shell fish-aware** — `src/util/envPath.ts loginShellPath` → оба launchEnv
- [x] **flattenContent** на границе адаптера (`src/agent/normalize.ts`) — картинки/структуры → маркеры, не сырой JSON
- [x] Packaging: `src/config/paths.ts` (APP/STAGED), `src/commands/build.ts`, `src/commands/update.ts` (local-first)
- [x] installBoot фикс (bootout-race → settle+kickstart) — `src/boot/install.ts`
- [x] SELF_ARGV под bundle — `src/env.ts`

**Frontend / TUI**
- [x] Ink inline+fullscreen, карточки (рамка+статус-бейдж+2-стр превью), транскрипт (whole-message windowing)
- [x] Мышь (wheel-zone-scroll, hover/click карт, drag-resize), compose-инпут (`i` → send)
- [x] Версия в шапке (`ccmux vX.Y.Z · fleet`)

**Ops / раскатка (local)**
- [x] bash отставлен, наш демон, сессии мигрированы с uuid, dev/prod развязаны, restoke вычищен полностью

**Что НЕ делалось (вынесено)**
- [x] Серверы → `planned/2026-06-09-ccmux-server-rollout.md`
- [x] CI + расширение тестов → `planned/2026-06-09-ccmux-ci-and-tests.md`
- [x] Codex launch/resume → `planned/2026-06-09-ccmux-codex-launch.md`
- [x] daemon auto-update / completions / help / git-remote+Releases → `planned/2026-06-09-ccmux-v1-polish.md`
- [x] git-коммит → по команде владельца (репо by design без коммитов)

**Ссылки на код**: `src/cli.ts`, `src/commands/`, `src/agent/`, `src/tui/`, `src/boot/install.ts`,
`src/util/envPath.ts`, `src/config/paths.ts`. Прод: `~/.ccmux/app/ccmux.js` + launchd `com.ccmux.daemon`.

## Вердикт
Bun-порт **функционально завершён и боевой локально**: полный паритет с bash v1.4.1 (+ мульти-агент,
live-TUI, compose, self-update), bash выведен с сохранением контекста. Остаток — раскатка на серверы +
CI + Codex-launch + polish — вынесен в 4 planned-задачи.
