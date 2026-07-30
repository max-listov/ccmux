---
title: Claude — структурный статус из hooks + statusLine-tee (уйти от pane-скрейпа)
description: working/idle/waiting из Claude Code hooks + context%/модель/стоимость из structured statusLine stdin-JSON (обёртка), без регекспа по нарисованному тексту; pane-скрейп — только cold-start fallback
type: task
status: done
created: 2026-07-30
updated: 2026-07-30
completed: 2026-07-30 10:29 +07:00
---

# Claude: структурный статус (hooks + statusLine-tee)

## Проблема
ccmux читает статус Claude-сессии из pane-скрейпа: `WORKING_RE` (спиннер) для working/idle и
`CONTEXT_RE` (`120k/1.0M 12%`) для context%. Второе **завязано на формат пользовательского
`statusline.ts`** — на дефолтном Claude / у другого юзера публичного ccmux регексп может не совпасть.
Working/idle — эвристика по глифам спиннера. Нет состояния «ждёт ввод/аппрув».

## Решение — два структурных claude-нативных источника (интерактив сохраняем)
Оба — стандартные фичи Claude Code, инжектятся через `--settings` (как уже делает чат Stop-hook),
не завязаны на личный конфиг → портируемы.

### A. Hooks → жизненный цикл (working/idle/waiting)
- Инжект хуков `UserPromptSubmit`/`Stop`/`Notification` → `<cli> hook-status <session>`.
- Хендлер читает hook-JSON из stdin (`hook_event_name` говорит какое событие), мапит:
  `UserPromptSubmit→working`, `Stop→idle`, `Notification→waiting`; пишет статус-файл.
- Payload несёт `session_id`/`transcript_path`/`cwd`/`permission_mode`/`effort` (проверено) — кладём заодно.
- Инжектим ВСЕГДА (working/idle — ядро), НЕ gated на chatEnabled. Существующий чат Stop-hook сосуществует
  (Claude поддерживает несколько хуков на событие; merge, не clobber — уже проверено для чата).

### B. statusLine-tee → метрики (context% / модель / стоимость)
- Инжект `settings.statusLine = { type:"command", command:"<cli> status-line <session>" }`.
- Обёртка: читает statusLine stdin-JSON, извлекает `model.display_name`, `context_window.used_percentage`,
  `context_window.context_window_size`, `cost.total_cost_usd` → пишет в тот же статус-файл; затем
  **прогоняет ОРИГИНАЛЬНЫЙ пользовательский statusLine сквозь себя** (тот же stdin) и печатает его вывод.
- Оригинал берём из `~/.claude/settings.json` `statusLine.command` (читаем один раз). Нет юзерского →
  печатаем ничего/минимум (визуал не навязываем).
- `used_percentage` — ровно то поле, что сейчас регекспим из рендера (валидировано: `statusline.ts`
  строит `usedTokens = size×pct/100`). Читаем на шаг выше, без регекспа/формат-зависимости.

### Статус-файл (единый)
`~/.ccmux/status/<session>.json` = `{ state, ts, event?, pct?, contextSizeTokens?, model?, costUsd?,
permissionMode?, effort?, transcriptPath? }`. Атомарная запись. Путь — хелпер в `config/paths.ts`.

### Reader (precedence, корректность)
- **state:** статус-файл есть → он источник (working/idle/waiting). Плюс backstop: пейн явно
  `esc to interrupt` (позитивный live working) → working, даже если файл говорит idle (закрывает
  cold-start дыру: сессия шла в момент (ре)старта ccmux, нового hook-события ещё нет).
- **context%:** статус-файл с `pct != null` → `usedTokens = size×pct/100` + pct; иначе счётчик токенов
  из jsonl (`sessionUsedTokens`, уже есть); `CONTEXT_RE` остаётся как переходный fallback.
- **model:** уже из jsonl (0.3.0); statusLine-tee даёт кросс-чек.
- Добавить `waiting` в `SessionState` union + цвета/глиф в TUI (`status.ts`/`format.ts`).

### Cleanup / lifecycle
- Статус-файл удаляется на `stop`/`rm` (как `scanCache`).
- Root-guard: инжект хуков/statusLine безопасен под root-демоном (команды — свои `<cli> …`).
- `--bare` сессии (skip hooks) → статус-файла не будет → fallback на пейн (корректно).

## Что это даёт
- context% из **структурных данных Claude**, не регекспом по тексту и не завязано на формат statusline
  → работает на дефолтном Claude и у любого юзера (портируемость, которой сейчас нет).
- Авторитетный working/idle (не «остановился ли спиннер») + **новое `waiting`** («агент поднял руку» —
  вход для пуша через `tool tg_send`).
- Точные `transcript_path`/`permission_mode`/`effort`/`cost` даром.
- Итог: pane-скрейп (`WORKING_RE`+`CONTEXT_RE`) уходит в **cold-start fallback**, не основной путь.

## Что НЕ входит (осознанно)
- `PreToolUse` tool-name как «running: Bash» активность / auto-approve по payload — отдельный заход (шумит на каждый тул).
- Codex-сторона (app-server) — отдельная большая таска.
- Вычислять % без `used_percentage` через жёсткую карту `модель→окно` — запрещено (хардкод); `context_window_size` берём из JSON Claude.

## Валидация (проведена ДО реализации — не гипотеза)
- [x] statusLine-обёртка ловит structured JSON + пользовательский statusline рендерится сквозь неё (живой tmux-прогон).
- [x] Поле-источник = `context_window.used_percentage`(+`context_window_size`) — то же, что сейчас скрейпим (по `statusline.ts`).
- [x] Интерактивные hooks файрят: `SessionStart`/`UserPromptSubmit`/`Stop` (живой tmux-прогон).
- [x] B не регрессит: `used_percentage` null (тривиальный контекст) → фолбэк на jsonl-счётчик.

## Acceptance
- [x] `hook-status` + `status-line` — сабкоманды (identity CCMUX_SESSION, stdin), пишут статус-файлы; status-line прогоняет оригинал.
- [x] Инжект хуков (UserPromptSubmit/**SessionStart**/Stop) + statusLine в `settingsArg()`, сосуществует с чат-хуком (union по докам; Notification НЕ инжектим — отложено).
- [x] Reader через `resolveLiveState` (pane-decisive) + pct из tee, фолбэк pane→jsonl.
- [x] `waiting` в `SessionState` — **→ отложено** (Notification ненадёжен в auto/bypass; блокирован-детект на `atInteractiveMenu`).
- [x] Cleanup статус-файлов на stop/rm/restart (`killSession` воронка).
- [x] **Твой statusline НЕ сломан** — e2e подтверждён (Powerline рендерится сквозь обёртку).
- [x] Тесты: hook-status мапинг, status-line извлечение/precedence/guard/minimal, resolveLiveState, cleanup, инжект settings.
- [x] `bun run check` зелёный (221 pass, 0 fail).

## Процесс (конвейер 2/2, без коммитов/деплоев)
- [x] 2 сабагента валидируют ПЛАН против кода (code-fit + correctness/риски).
- [x] Пробники решающих гипотез (§16) — см. «Уточнения после валидации».
- [x] Находки вобраны (секция ниже) → `in-progress/`.
- [x] Реализация по УТОЧНЁННОМУ плану.
- [x] Гейты (`bun run check`: 221 pass, 0 fail, typecheck чист) + живая проверка «statusline не сломан» (Powerline рендерится сквозь обёртку — e2e).
- [x] 2 сабагента валидируют РЕАЛИЗАЦИЮ → находки исправлены (секция ниже).
- [x] Отчёт → `done/`. **Без коммита и без деплоя** (явное указание Max).

---

# Валидаторы реализации — находки и фиксы

**HIGH (оба агента) — stale `working` после ESC-interrupt.** Backstop был асимметричен. **Фикс:**
`resolveLiveState` (pane-решающий: spinner→working, `scan.ready`→idle перебивает stale lifecycle-working,
lifecycle только в boot-окне). `src/agent/sessionStatus.ts` + тест.

**MEDIUM R2 — statusLine через полный `cli.ts` (отступление от §4).** **Замерено: ~50-60мс/вызов**
(dev; прод-бандл быстрее), дебаунс 300мс → пренебрежимо; ink/react и так lazy. Изолированный энтри не
нужен — descope с обоснованием.

**MEDIUM #2 — merge hooks того же события.** Живой пробник флаки (project-settings trust). Полагаемся
на **документированное union** (hooks из разных источников конкатенируются) + прецедент чат-хука. Свериться на реальном деплое.

**MEDIUM R3a/L1 — пустой бар у юзеров без statusline.** **Фикс лучше принятия:** `minimalStatusline` —
при отсутствии оригинала рисуем полезный дефолт (model · context%), не пустоту. Тест.

**LOW #3** precedence оригинала (local перед settings.json) — фикс+тест. **LOW #4** recursion-guard
`(^|\s)status-line(\s|$)` (не ловит `status-line-pretty.sh`) — фикс+тест. **LOW #5** full fail-open
(`process.cwd()` в try) — фикс. **LOW #6** `safe(name)` неинъективен для `/` — degenerate (имена
запрещают whitespace), оставлено с пометкой. **LOW R4** status-reads без mtime-кэша — tiny-файлы,
оставлено. **LOW R5** chat-off сессии спавнят hook-subprocess'ы — приемлемо.

**Подтверждено НЕ регрессиями:** чат stop-hook цел (hook-status молчит), `list --json` контракт тот же,
context precedence (pct=null НЕ клобает хороший пейн), cleanup на всех kill-путях, codex-fallback,
isolated-dev изоляция, exhaustiveness (waiting отложен).

# Что сделано

**Новое**
- [x] `src/agent/sessionStatus.ts` — стор (2 файла lifecycle+metrics, zod-схемы, `atomicWrite`,
  `readLifecycle/readMetrics/writeLifecycle/writeMetrics/clearStatus`, `resolveLiveState`).
- [x] `src/commands/hookStatus.ts` — `parseLifecycle` (event→state) + `cmdHookStatus` (молчаливый, fail-open, CCMUX_SESSION).
- [x] `src/commands/statusLine.ts` — `extractMetrics` + `originalCommand` (precedence+guard) + `minimalStatusline` + `cmdStatusLine` (tee, fully fail-open).
- [x] `src/config/paths.ts` — `STATUS_DIR`.

**Изменено**
- [x] `src/agent/claude/launch.ts` `settingsArg` — инжект hooks (UserPromptSubmit/SessionStart/Stop) + statusLine всегда; чат stop-hook сосуществует на Stop.
- [x] `src/commands/list.ts` `buildRow` — `resolveLiveState` (authoritative working/idle, pane-decisive) + context% из metrics (иначе pane, иначе jsonl).
- [x] `src/tmux/tmux.ts` `killSession` — `clearStatus` (все kill-пути). `src/cli.ts` — 2 скрытых verba.

**Тесты** — `test/{session-status,hook-status,status-line}.test.ts` + `launch.test.ts` (инжект settings). `bun run check`: 221 pass, 0 fail.

**Что дало (v1)**
- **B (главный выигрыш):** context% из структурного JSON Claude (`used_percentage`×`context_window_size`),
  **без регекспа и без завязки на формат твоего statusline** → портируемо (дефолтный Claude, любой юзер).
  Твой statusline рендерится сквозь обёртку неизменным; у кого нет — минимальный дефолт.
- **A:** working/idle остаётся pane-решающим (пейн надёжен + interrupt), hooks пишут lifecycle-файл
  (substrate под будущий push/waiting + captures permission_mode/effort/transcriptPath). Честно: для
  ДИСПЛЕЯ working/idle A даёт мало (пейн и так хорош); ценность A — инфраструктура под push-фичу.

**Что НЕ делалось (v1):** `waiting`/Notification/пуш (Notification ненадёжен в auto/bypass), PreToolUse-активность,
auto-approve, изолированный statusLine-энтри (замер показал не нужно). Блокирован-детект — на `atInteractiveMenu`.

---

# Уточнения после валидации (2 плановых агента + живые пробники) — ЭТО канон реализации

Первоначальный набросок выше оставлен как контекст; где расходится — следуем этому разделу.

## Пробники (факты, не гипотезы)
- ✅ **hooks UserPromptSubmit/Stop файрят надёжно в интерактиве** (2 turn'а → PROMPT→STOP каждый).
- ✅ **statusLine-tee подтверждён**: обёртка ловит JSON, юзерский statusline рендерится сквозь неё; `used_percentage=12` реально наполнен в живой сессии (`120.0k/1.0M 12%`).
- ⚠️ **`Notification` НЕ сработал** ни на idle, ни на тул в **auto-mode** (тул авто-аппрувнулся). → «waiting» через Notification в наших режимах (auto/bypass) **ненадёжен**.

## Изменения дизайна (обязательные)

### 1. «waiting» через Notification — ОТЛОЖИТЬ (v1 не строит на нём)
- Notification ненадёжен + файрит на много типов, вкл. `idle_prompt` (=idle) → без гейта по
  `notification_type` каждая idle-сессия станет «waiting» + спам пуша. В auto/bypass он вообще молчит.
- **v1:** «блокирован/ждёт» берём из УЖЕ существующего `atInteractiveMenu` (pane `❯ N.` меню — работает
  сегодня, ноль регресса). Notification-хук НЕ инжектим. Состояние `waiting`/пуш — отдельный заход,
  когда/если найдём надёжный триггер. **Убирает C1/C4 из скоупа v1.**
- Фокус A = железные **working/idle** из `UserPromptSubmit`/`Stop`.

### 2. Cold-start / stale «working» — инжектить `SessionStart`, сбрасывать в idle
- На `--resume` файрит только `SessionStart(source:"resume"|"startup")`, НЕ UserPromptSubmit/Stop.
  На ESC-interrupt `Stop` не файрит → без сброса файл застрянет `working`.
- **Инжектить `SessionStart` → hook-status пишет `idle`** (свежий старт, turn не идёт). Плюс backstop:
  пейн явно `esc to interrupt` → working. Оба направления закрыты (не только →working).

### 3. ДВА файла статуса, не один (гонка lost-update)
- `~/.ccmux/status/<name>.lifecycle.json` — пишут ТОЛЬКО hooks (`{state, ts, event, permissionMode, effort, transcriptPath}`).
- `~/.ccmux/status/<name>.metrics.json` — пишет ТОЛЬКО statusLine-обёртка (`{pct, contextSizeTokens, model, costUsd, ts}`).
- Разные писатели → нет разделяемой записи → лока не нужно. `atomicWrite` из `src/util/atomic.ts`.

### 4. statusLine-обёртка — минимальный изолированный вход + полная precedence + guard
- `status-line` НЕ гнать через полный `cli.ts` (23 импорта на горячем пути, statusLine дебаунс ~300мс/сообщение).
  Отдельный крошечный модуль-энтри; читает stdin, пишет metrics-файл, exec оригинала с ТЕМ ЖЕ stdin/cwd.
- **Оригинал ищем по precedence Claude:** project `.claude/settings.json` → `.claude/settings.local.json`
  → `~/.claude/settings.json` (не только глобал — иначе project-statusline юзера ИСЧЕЗНЕТ). Первый найденный `statusLine.command`.
- **Recursion guard:** если найденный command содержит наш `status-line` — пропустить.
- Нет оригинала (дефолтный Claude) → печатаем пусто (принять/проверить L1: не рисует ли пустой бар).

### 5. Рендер-путь = `deriveStatus`/`fleet.ts`, НЕ `SessionState`/`format.ts`
- `format.ts` `stateColor`/`dotGlyph` — **мёртвый код** (0 потребителей), не они рисуют.
- working/idle оверлеим из lifecycle-файла в `buildRow` (`list.ts`), а в TUI — прокинуть авторитетный
  `isWorking` в `fleet.ts:deriveStatus` (сейчас `isWorking = state==="working" || recentlyActive`).
- `SessionState` НЕ обязателен к расширению в v1 (waiting отложен) → C2-exhaustiveness не проблема.

### 6. hook-status handler — молчаливый, парсит stdin, identity из argv
- Печатает НИЧЕГО (exit 0), иначе stdout коллизит с чат `stop-hook` `{decision:block}`. Fail-open как `stopHook.ts`.
- Парсит `hook_event_name` из stdin → state. Identity = argv `<name>` (стабильно), не `CCMUX_SESSION`/`session_id`.
- **Stop→idle нюанс:** когда чат-хук вернул `block`, turn продолжится — краткий флап idle→working закрывает pane-backstop. Коммент.

### 7. Cleanup — на всех kill-путях
- Единая воронка `killSession` (`src/tmux/tmux.ts`) ИЛИ хелпер `clearStatus(name)` в 6 местах:
  `cmdStop`/`cmdRestart` (`lifecycle.ts`), `cmdRm` (`rm.ts`), TUI `actions.ts` (stop/rm/restart). Оба файла статуса.
- `rm` удаляет из реестра → `buildRow` больше не вызовется → **явный unlink в rm обязателен** (не только lazy).

## Уточнённый список файлов
`schema.ts` (waiting — ТОЛЬКО если делаем; в v1 нет) · `agent/claude/launch.ts` (`settingsArg`: un-gate,
Stop-массив с обоими хуками, +UserPromptSubmit +SessionStart +statusLine) · `cli.ts` (2 hidden verba) ·
**new** `commands/hookStatus.ts` · **new** минимальный `commands/statusLine.ts` (изолированный) ·
`config/paths.ts` (`STATUS_DIR`) · `commands/list.ts` (`buildRow`: overlay lifecycle-state + pct→tokens) ·
`agent/index.ts` (`sessionStatus()` reader, 2 файла) · `tui/fleet.ts`+`tui/status.ts` (`deriveStatus` берёт авторитетный isWorking) ·
`tmux/tmux.ts` или kill-сайты (cleanup) · тесты.

## Скоуп v1 (сузили по фактам)
**Делаем:** working/idle из hooks (UserPromptSubmit/Stop/SessionStart) + context%/модель/cost из statusLine-tee,
два файла, cleanup, reader-precedence, deriveStatus. **Не делаем в v1:** `waiting`/Notification/пуш (ненадёжно),
PreToolUse-активность, авто-approve. Блокирован-детект остаётся на `atInteractiveMenu` (как сейчас).
