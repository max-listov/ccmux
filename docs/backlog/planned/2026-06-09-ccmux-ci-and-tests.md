---
title: ccmux — CI + добить юнит-тесты
description: GitHub Actions (bun test + bundle build) и юниты на новые модули (list-json, transcript, doctor, update, TUI-логика)
type: task
status: planned
created: 2026-06-09
updated: 2026-06-09
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## План
- [ ] `.github/workflows/ci.yml`: `bun install` → `bun run typecheck` → `bun test` → `bun build --target=bun` (bundle), на push/PR
- [ ] Юниты на новые модули: `list --json`, transcript-адаптеры (claude/codex), `doctor`, `update` (local-staged + remote + rollback), TUI-логика (fleet/window/wrap)
- [ ] (опц.) per-arch bundle-артефакт в Releases для remote self-update

## Acceptance
- [ ] CI зелёный на push; покрытие новых модулей юнитами
