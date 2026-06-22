---
title: ccmux — парити-аудит из bash-легаси (3 саб-агента) + фиксы
description: Независимый read-only аудит bash v1.4.1 → Bun-порт тремя агентами (команды/флаги, daemon/launch/boot, data/parsing); найденные реальные дивергенции исправлены
type: task
status: done
created: 2026-06-09
updated: 2026-06-09
completed: 2026-06-09 13:04
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## Что делали
3 read-only саб-агента независимо сверили прежнюю bash-реализацию (v1.4.1) против нашего
`src/` по трём осям: (1) команды/флаги, (2) daemon/launch/boot internals, (3) data/parsing.

## Найдено и исправлено

### 🔴 Критичные (фикс)
- [x] **encodeDir** (`agent/claude/resume.ts`): меняли только `/`→`-`, а Claude меняет **каждый
      не-алфанум** (`.` `_` пробел) → `-`. Любая папка с точкой/подчёркиванием → транскрипт не
      найден → resume падает в `--session-id` → «already in use» луп. Фикс: `replace(/[^a-zA-Z0-9]/g,"-")`.
      + тест на `/tmp/cc.dot_test`→`-tmp-cc-dot-test`. (Текущие сессии работали случайно — в их путях нет спецсимволов.)
- [x] **`KillMode=process`** в systemd-юните (`boot/render.ts`): без него `systemctl restart`/`ccmux update`
      на Linux SIGTERM'ит весь cgroup → **все tmux-сессии умирают** на bounce. bash ставил это спецом.
      Server ship-blocker (на mac/launchd проблемы нет). Фикс + рендер-проверка.

### 🟠 Исправлено
- [x] **Промпт `--then`** (`agent/claude/prompt.ts`): инжектируемый промпт потерял `restart NAME
      [--then "<note>"]` → агент не знал про self-restart-and-resume. Восстановлено + тест обновлён.
- [x] **`fmtTokens`** (`tui/format.ts` + `commands/list.ts`): округляли (`1500→2k`), bash усекает
      (`1k`). Фикс `Math.floor` в обоих местах (дубль — отдельно).
- [x] **`send-keys --`** (`tmux/tmux.ts`): вернул `--` guard, payload с ведущим `-` не парсится как флаг.

### ⚪ Намеренные дивергенции (НЕ трогаем — обоснованы)
- [x] launchd `KeepAlive: SuccessfulExit=false` (vs bash always) — корректнее: exit 0 = «лежать тихо»
- [x] `doctor --json` ключи (`bins/deps`, без `jq`) — у нас нет jq, парсинг нативный
- [x] `install` требует `--rc-prefix` на первом запуске — защита от mislabeled fleet box
- [x] `_restart_worker`→`_restart-worker`, дефолт boot-label `com.ccmux.daemon`, лог-пути — внутренне консистентно
- [x] `transcript --tail 0`→1 (vs 200), `tokNum` на мусорных лейблах — edge, в реальных данных не встречается
- [x] `dirname(SELF)` не в child PATH — промпт зовёт абсолютным путём, `ccmux` в `~/.local/bin` (на PATH)

## Подтверждённый паритет (без дивергенций)
Backoff 2s→60s · fast-fail<5s · 3-fails→fork · resume-vs-fresh · ensure 30s · self-guard · `=name`
exact-match · pane-опции · token-sum (3 поля, last assistant) · pane-скрейп регэкспы (1:1) · реестр
(JSONL + legacy pipe tolerant) · transcript JSON shape · logs.

## Деплой
Все фиксы → прод **v0.0.4** (бандл, демон bounced, сессии целы). 37 тестов зелёные (117 проверок).

## Вердикт
Паритет с bash v1.4.1 — **полный**. Два реальных бага (encodeDir, KillMode) исправлены — encodeDir
был латентным (бил бы на папках со спецсимволами), KillMode — обязателен перед серверной раскаткой
(учтён в `planned/2026-06-09-ccmux-server-rollout.md`).
