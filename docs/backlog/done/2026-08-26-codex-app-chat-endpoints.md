---
title: Подключить Codex App threads к общему inter-agent chat
description: Дать App Server threads точную identity, общий ledger и fail-closed двустороннюю доставку
type: task
status: done
created: 2026-08-26
updated: 2026-08-27
completed: 2026-08-27 00:12 +0700
---

Codex App threads уже обнаруживаются как external inventory, но не являются chat endpoints. Команда,
запущенная из такого thread, сейчас записывается как безымянный CLI sender, а входящего маршрута к
точному thread нет. Из-за этого сообщения обходят общий ledger либо теряют reply identity, и
downstream-потребители событий не видят одного из реальных участников разговора.

## Результат

- App thread имеет отдельную structured identity: source, provider, machine, immutable thread UUID и
  user-facing title snapshot. Cwd, project name и recency никогда не участвуют в выборе адресата.
- Команда из App thread автоматически подтверждает свой runtime thread ID через App Server и пишет
  обычный ccmux envelope; сообщения попадают в тот же ledger и mirror, что managed chat.
- Адрес `app/<thread-uuid>` и fleet-вариант `<machine>:app/<thread-uuid>` доставляют в точный thread
  через уже работающий App Server daemon, не создавая второго provider writer.
- Idle/not-loaded thread получает новый turn; active, approval, elicitation, partial input,
  system-error и неизвестное состояние удерживаются fail-closed с объяснимой причиной.
- Delivery intent и completion сохраняются так, чтобы restart ccmux не дублировал уже принятый turn.

## План

- [x] Добавить App thread principal/target и exact address parsing без изменения managed namespace.
- [x] Реализовать bounded WebSocket JSON-RPC adapter к существующему App Server control socket.
- [x] Подключить App sender detection, local/fleet receive и daemon delivery к общему ledger.
- [x] Обновить reply framing, inbox/hold reasons, mirror labels и архитектурную документацию.
- [x] Покрыть identity, status gates, retry/dedup и protocol transport regression-тестами.
- [x] Доказать real round-trip App thread → ccmux ledger/mirror → peer reply → тот же App thread.

## Acceptance

- [x] Ledger и mirror показывают точный App sender, а не `ccmux/cli`.
- [x] Reply попадает только в UUID, указанный в immutable envelope, даже при одинаковом cwd/title.
- [x] App Server unavailable/version mismatch не приводит к append или ложной delivery ack.
- [x] Busy/approval/partial/unknown состояния не получают скрытый steer или смешанный input.
- [x] После restart незавершённая доставка безопасно продолжается без duplicate turn.
- [x] Existing managed Claude/Codex chat и external-owner routing остаются зелёными.

## Проверка

- Полный gate: `bun run check` — 677 tests, 0 failures.
- Real App Server round-trip прошёл через обычный ledger в обе стороны; обратное сообщение сохранило
  exact source, machine и thread UUID, а title остался только отображаемым snapshot.
- Persisted pickup regression проверяет exact `client_id` даже на границе stream chunk и отвергает
  UUID, встреченный только в тексте.
- Real process-restart E2E сохранил pickup до submit, завершил первый process после принятия turn,
  затем новым process подтвердил persisted `client_id`, очистил barrier и не создал второй turn.

## Что сделано

- [x] Chat identity и exact addressing: `src/config/schema.ts`, `src/chat/identity.ts`,
  `src/commands/msg.ts`.
- [x] App Server transport и delivery: `src/agent/codex/appServer.ts`,
  `src/chat/codexApp.ts`, `src/chat/deliver.ts`.
- [x] Restart-safe persisted pickup: `src/agent/codex/appPickup.ts`.
- [x] Reply framing, labels и CLI help: `src/chat/format.ts`, `src/chat/replyRoute.ts`,
  `src/commands/help.ts`.
- [x] Architecture: `docs/VISION.md`, `docs/architecture/external-session-ownership.md`,
  `docs/architecture/peer-routing.md`.
- [x] Regression coverage: `test/codex-app-chat.test.ts`, `test/msg-identity.test.ts`,
  `test/msg-provenance.test.ts`; полный gate — 677 tests, 0 failures.
