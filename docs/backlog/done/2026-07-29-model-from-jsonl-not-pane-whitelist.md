---
title: Модель сессии — из jsonl, не из pane-whitelist
description: ccmux терял model у сессий на новых семействах Claude (Fable/Mythos), т.к. скребёт модель из статуслайна по whitelist имён. Источник правды — jsonl.
type: task
status: done
created: 2026-07-29
updated: 2026-07-29
completed: 2026-07-29 18:31 +07:00
---

# Модель сессии — из jsonl, а не из pane-whitelist

## Проблема (подтверждена на живых данных)

`ccmux list --json` отдавал `model: null` для части сессий флота. Пробник показал:
безмодельными оказывались ровно сессии на **Fable 5** (семейство Claude 5), тогда как
Opus/Sonnet/Haiku читались нормально.

Корень — `src/agent/claude/pane.ts`:
```ts
const MODEL_RE = /(Opus|Sonnet|Haiku) [\d.]+/;
```
Модель скребётся из **рендера статуслайна** по **whitelist семейств**. Любое новое
семейство (Fable, Mythos, …) в списке отсутствует → нет совпадения → `null`. Это второй
заход одного класса: дописать имя = починить сегодня и снова сломаться на следующем.

### Почему pane — вообще неверный источник для модели
1. Статуслайн — **произвольный пользовательский** (`~/.claude/statusline.ts`); публичный
   тул не может закладываться на его формат.
2. Статуслайн отражает модель на **момент старта**, а не текущую (устаревает при `/model`).
3. Противоречит собственному VISION: *«jsonl — источник правды (транскрипт, токены,
   модель); pane-скрейп — только для live-статуса»*. Модель — метаданные беседы, не live.

`context.percent` при этом читается корректно — его null (наблюдался на части сессий) —
отдельный интермиттент (статуслайн не попал в захват), не этот баг.

## Решение

**Модель — из jsonl `message.model` (источник правды), whitelist имён удалить полностью.**
Pane-скрейп сжимается до реально live-сигналов: `state` (working/idle) + best-effort
`context`. Для «UI отрисован» (нужно двум `waitReady`) — честный boot-маркер из pane,
не завязанный на модель.

### Гочи jsonl (из пробника — учтены)
- `message.model` бывает `"<synthetic>"` (служебные сообщения при ошибке/прерывании) —
  пропускать.
- Модели генерации картинок (`nano-banana-2`, `gpt-image-2`) сидят внутри тул-пейлоадов —
  читать строго `entry.message.model` у `role==="assistant"`.
- Codex-модель живёт в `turn_context.payload.model` (напр. `gpt-5.6-sol`) — тоже jsonl.

### Отображение — без хардкода моделей
Чистый transform id → имя: strip префикса провайдера (`claude-`), Title-case семейства,
числа версии через `.`, 8-значный снапшот-суффикс дропнуть; не подошло под форму →
сырой id со срезанным префиксом (всегда корректно).
```
claude-fable-5          → Fable 5
claude-opus-4-8         → Opus 4.8
claude-haiku-4-5-2025…  → Haiku 4.5
gpt-5.6-sol             → gpt-5.6-sol   (raw fallback)
```

### Boot-маркер («UI отрисован») вместо model!==null
claude-native, независим от статуслайна (проверено на живых пейнах):
`(shift+tab to cycle)` (idle) | `esc to interrupt` (working).

## Acceptance
- [x] `MODEL_RE` удалён из claude И codex `pane.ts`.
- [x] `PaneScan.model` → `PaneScan.ready` (boolean); `state`/`context` без изменений.
- [x] `AgentProvider.lastModel(lines)` — claude (assistant + skip `<synthetic>`) и codex
      (`turn_context.payload.model`).
- [x] `sessionModel()` в `src/agent/index.ts` — mtime-кэш (`modelCache`), как `sessionUsedTokens`.
- [x] `prettyModel()` — чистый transform, отдельный модуль `src/agent/format.ts`.
- [x] `list.ts` / `fleet.ts` / `discover.ts` — один источник модели (jsonl) и один
      форматтер; дубль `discover.lastModel` и `.replace(/^claude-/)` убраны.
- [x] `actions.ts` / `lifecycle.ts` `waitReady` — на `scan.ready`.
- [x] `ListItem.model` в `--json` остаётся display-строкой (снапшот стороннего потребителя не ломается).
- [x] Тесты: prettyModel (вкл. выдуманный `claude-zephyr-9 → Zephyr 9`), lastModel
      (synthetic-skip, role-scope, codex turn_context), pane ready. `test/{pretty-model,
      last-model,pane-ready}.test.ts`.
- [x] `bun run check` зелёный (181 pass, 0 fail, typecheck чист).

## Процесс
- [x] Реализация по плану.
- [x] Гейты (`bun run check`) + e2e на живых сессиях: `bun run src/cli.ts list --json` —
      ранее-null Fable-сессии теперь кажут `Fable 5`, Opus/5 без регрессий.
- [x] Отчёт Максу; релиз на флот (patch 0.2.1) — по явному «GO», CI зелёный, опубликован.

## Что сделано

**Shared**
- [x] `src/agent/format.ts` — `prettyModel(id)`: чистый transform id→имя, без таблицы моделей;
      strip префикса `claude-`, Title-case семейства, версия через `.`, дроп 8-значного снапшота,
      raw-fallback для off-shape (codex `gpt-5.6-sol`, alias `opus`).
- [x] `src/agent/index.ts` — `AgentProvider.lastModel(lines)` в контракте; `sessionModel()` +
      `modelCache` (MtimeCache, idle-флот платит ноль); `PaneScan.model` → `PaneScan.ready`.

**Reading (jsonl = источник правды)**
- [x] `src/agent/claude/transcript.ts` — `lastModel()`: последний `role:"assistant"` ход,
      пропуск `<synthetic>`, tool-payload-модели игнорируются.
- [x] `src/agent/codex/transcript.ts` — `lastModel()`: последний `turn_context.payload.model`.
- [x] Провайдеры (`claude/index.ts`, `codex/index.ts`) — регистрируют `lastModel`.

**Pane (только live-сигналы)**
- [x] `src/agent/claude/pane.ts` — `MODEL_RE` удалён; `READY_RE` (claude-native
      `shift+tab to cycle` / `esc to interrupt`), `scanPane` отдаёт `ready`.
- [x] `src/agent/codex/pane.ts` — `MODEL_RE` удалён; `ready` best-effort.

**Consumers (один источник + один форматтер)**
- [x] `src/commands/list.ts` — `model: prettyModel(sessionModel(s, m))`.
- [x] `src/tui/fleet.ts` — `prettyModel(ext.model)` (дубль `.replace(/^claude-/)` убран).
- [x] `src/tui/discover.ts` — локальный `lastModel` удалён, использует общий hardened.
- [x] `src/tui/actions.ts` + `src/commands/lifecycle.ts` — `waitReady` на `scan.ready`.

**Тесты**
- [x] `test/pretty-model.test.ts` (вкл. `claude-zephyr-9 → Zephyr 9` = гарантия «не хардкодим»),
      `test/last-model.test.ts`, `test/pane-ready.test.ts`. `bun run check`: 181 pass, 0 fail.

**Что НЕ делалось**
- Вычисление `context.percent` из jsonl — отклонено: требует карты `модель→размер_окна`
      (= хардкод). % остаётся best-effort из статуслайна, null=«неизвестно» честно.

**Ссылки на код:** `src/agent/format.ts:18` (prettyModel), `src/agent/claude/transcript.ts`
(lastModel), `src/agent/index.ts` (sessionModel/PaneScan.ready), `src/agent/claude/pane.ts`
(READY_RE). Релиз: `v0.2.1`.
