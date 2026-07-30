---
title: ccmux — CI + добить юнит-тесты
description: GitHub Actions (bun test + bundle build) и юниты на новые модули (list-json, transcript, doctor, update, TUI-логика)
type: task
status: done
created: 2026-06-09
updated: 2026-07-30
completed: 2026-07-30 08:40 +07:00
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## План
- [x] `.github/workflows/ci.yml` — есть и БОГАЧЕ плана: `bun run check` (typecheck+test) → build bundle → **smoke** (собранный бандл реально запускается: `version`/`list --json`) → `--ci-assets` (versioned asset+manifest). На push/PR + на теге публикует Release.
- [x] Юниты на новые модули — добито 2026-07-30 (см. «Что сделано»): transcript-адаптеры, list-CTX-парсинг, TUI window/wrap, `update` (decision). `fleet`/`lib` уже были.
- [x] per-arch bundle-артефакт — **не нужен**: один портируемый `--target=bun` бандл покрывает все арки, целостность старта проверяет `bundle-selfcontained.test`.

## Acceptance
- [x] CI зелёный на каждый push (валидировано живыми прогонами); ключевые новые модули покрыты юнитами.

## Что сделано

- [x] **CI** — `.github/workflows/ci.yml`: check → build → smoke → ci-assets/publish (уже боевой, гоняется на каждый релиз).
- [x] **Юниты добиты (2026-07-30):**
  - `test/transcript-adapters.test.ts` — claude tool_call↔result fold + codex `response_item` message.
  - `test/context-parse.test.ts` — `parseContext`/`tokNum` (ядро CTX-колонки `list`/`list --json`).
  - `test/format-width.test.ts` — TUI window/wrap: `wrapText`/`dispWidth`/`sliceToWidth`/`clipWidth`/`fmtTokens`/`pad`.
  - Ранее: `update-decision`, `fleet`, `lib`, `pretty-model`, `last-model`, `pane-ready`, `bundle-selfcontained` и др.
- [x] `bun run check`: **206 pass, 0 fail**, typecheck чист.

**Что НЕ делалось (осознанно):** прямой юнит `doctor`/полного `collectRows` — оба IO-тяжёлые
(shell-out/tmux/fs), покрыты интеграционно CI-smoke'ом (бандл реально запускается и зовёт `list --json`).
Мокать весь tmux/fs слой ради юнита — хрупко, ценность ниже цены.
