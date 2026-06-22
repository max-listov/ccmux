---
title: ccmux — Codex launch/resume (закрыть launch-гэп)
description: Запуск/резюм для agent=codex — id-pin, resume по нашему uuid, RC-имя, инъекция управляющего промпта
type: task
status: planned
created: 2026-06-09
updated: 2026-06-09
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## Контекст
ЧТЕНИЕ Codex (transcript/pane/locate) уже 1:1 через провайдер. Открыт только LAUNCH:
- Codex на новой сессии генерит СВОЙ id (не наш uuid) → `resume.ts` не находит первый rollout
- нет `--append-system-prompt` → инъекция управляющего промпта и RC (`-n` эквивалент) не заведены

## План
- [ ] Runtime-спайк: как Codex пинит id / резюмит → согласовать с нашим uuid (id-reconcile или маппинг)
- [ ] RC-имя для Codex (аналог `-n local-<name>`), если есть
- [ ] Инъекция управляющего промпта (если поддерживается) либо альтернатива
- [ ] e2e: создать codex-сессию через `ccmux new ... --agent codex`, resume, send

## Acceptance
- [ ] `agent=codex` сессия запускается/резюмится через ccmux 1:1 с Claude (насколько Codex CLI позволяет)
