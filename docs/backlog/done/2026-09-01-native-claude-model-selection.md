---
title: Model selection, effort and images for the native Claude mode
description: Carry the three inputs the native mode currently declares it does not support, so a caller can choose a model, an effort level and attach an image.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 12:50 +0700
priority: P2
related: docs/backlog/done/2026-09-01-optional-claude-native-runtime.md
---

## Why

The native Claude mode ships with three capabilities declared false and enforced as false:
`modelCatalog`, `modelSelection` and `imageInput`. That is honest — nothing behind them is
implemented — but each is a real thing the runtime itself accepts, and the other native runtimes
already carry them.

The enforcement is new and worth keeping in view: images used to be admitted for any native session,
pinned, receipted as accepted, and then dropped by a runtime that never read them. A caller saw
success and the model never saw the image. `src/control/message.ts` now refuses them against the
declared capability, so this task is about making the answer yes rather than about stopping a lie.

## Result

- A caller can name a model and an effort level for a native Claude turn, and the runtime uses them.
- A caller can attach an image and the model receives it.
- The catalog reports what this host can actually run, rather than nothing.

## Boundaries

Selection must not become a second way to assert provenance: the runtime family stays `claude`, and
a model choice is a turn option, not a new session kind. Do not advertise a capability before the
path behind it works — the declaration is what the control plane answers on.

## Что сделано

### Runtime

- [x] Каталог моделей публикуется владельцем сессии: `src/agent/claude/native/catalog.ts`
      (`claudeModels`, `writeClaudeCatalog`, `readClaudeModels`). Список берётся у самого runtime
      через `query.supportedModels()` — читатель каталога живёт в другом процессе и соединения не
      имеет, поэтому владелец оставляет ответ рядом со своим status-файлом.
- [x] `model` в строке каталога — тот alias, которым выбирают (`haiku`), а не разрешённый wire id:
      сверка выбора идёт именно по этому полю.
- [x] Выбор модели на ход: `selectModel` в `src/agent/claude/native/owner.ts` через
      `query.setModel()`, применяется до постановки хода в очередь.
- [x] Effort: `query.applyFlagSettings({ effortLevel })` там же. Per-turn setter'а у runtime нет,
      уровень действует до конца сессии — это сказано в комментарии, а не выдано за per-turn.
- [x] Уровни effort публикуются **по модели** из `ModelInfo.supportsEffort` /
      `supportedEffortLevels`, а не фиксированным списком: haiku не принимает ни одного уровня,
      остальные принимают пять.
- [x] `effort` в `src/runtime/selectionSchema.ts` — bounded string, а не enum из пяти имён:
      единственный источник правды — каталог, а закрытый enum рядом с ним был бы вторым и более
      старым.
- [x] Изображения: `blocks()` в `owner.ts` разрешает приколотые вложения в base64 image-блоки и
      падает, если разрешилось меньше, чем прислали, — молчаливая потеря картинки отвечала бы на
      другой вопрос.

### Control plane

- [x] `imageInput`, `modelCatalog`, `modelSelection`, `turnOptions`, `selectionDefaults` объявлены
      true для профиля claude+native в `src/runtime/capabilities.ts`; строка `tui` не изменилась.
- [x] `inputModalities: ['text','image']` в каталоге с указанной провенансой: runtime модальности
      не сообщает, а каталог, объявляющий text-only, заставлял control plane ОТКАЗЫВАТЬ в картинке,
      которую runtime принимает.
- [x] Проверка effort по каталогу больше не привязана к одному runtime: `effortAccepted` в
      `src/control/selection.ts`. Написанная как ветка `runtime === 'codex'`, она пропускала любой
      claude-ход с effort мимо проверки.
- [x] Каталог маршрутизировался по агенту, игнорируя runtime: интерактивная claude-сессия
      получала ответ нативного режима («Native runtime catalog is unavailable») вместо честного
      «этот runtime каталога не отдаёт». Разделено в `readClaudeModels`.
- [x] Ветка выбора для claude в `currentSelection`: без неё каждое `message.send` в native
      claude-сессию отвечало 409.

### Тесты

- [x] `test/claude-native-mode.test.ts`: публикация уровней effort по модели и `effortAccepted`
      для любого runtime.

### Живая проверка (изолированный инстанс, свой stateDir и tmux-сокет)

- [x] Модель: ход, отправленный с `model: sonnet` в сессии, созданной на haiku, выполнен sonnet —
      опубликованный `nativeSelection` после хода назвал sonnet.
- [x] Effort: `haiku` + `effort` — отказ `Requested reasoning effort is unavailable` (каталог у
      haiku пуст); `sonnet` + `effort: low` — принят, и сессия сама сообщила `EFFORT=[low]`
      (по умолчанию у неё `high`).
- [x] Картинка: PNG 200×200 через `attachment.*` и `message.send`, ответ — «Красный.»
- [x] Одобрение инструмента в этом же ходе прошло через control plane: квитанция `submitted`.

### Что не сделано

- [x] Диалоги (`onUserDialog`) — по-прежнему не объявлены: рендерить их нечем, а объявленный без
      обработчика вид диалога runtime не запускает вовсе. Отдельной задачи не заводил: это граница
      режима, а не недоделка.
