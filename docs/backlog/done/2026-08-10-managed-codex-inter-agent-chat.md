---
title: Довести inter-agent chat для managed Codex-сессий
description: Научить ccmux безопасно доставлять msg в Codex TUI и ждать настоящую границу хода
type: task
status: done
created: 2026-08-10
updated: 2026-08-26
completed: 2026-08-26
---

Persistent managed Codex CLI sessions are now required for inter-agent chat. The implementation
remains fail-closed until real pane frames and the two-session E2E prove safe delivery.

## Зачем

Сейчас Codex provider не реализует `chatDeliverable` и `inputBusy`, а его pane scanner прямо помечен
как некалиброванный. Поэтому `ccmux msg` заранее отказывает Codex-получателю: daemon никогда не
доставит письмо, даже если session managed, chat включён и pane idle. `wait` при этом опирается на
тот же недостаточно проверенный live state.

Нативный `send_message_to_thread` решает переписку только между задачами, созданными Desktop host.
Обычный Codex CLI не получает этот tool, а resume CLI-origin thread внутри Desktop сохраняет исходный
tool registry. Следовательно persistent CLI-флоту нужен собственный ccmux transport, а не попытка
переиспользовать Desktop task bus.

## Результат

- Managed Codex session может отправлять `ccmux msg`, получать его и отвечать через тот же адресный
  канал локально и по fleet address.
- Доставка не нажимает Enter на approval/selection menu и не склеивается с человеческим вводом.
- Busy turn, idle composer, approval prompt, partially typed input и недорисованный TUI различаются
  по реальным Codex frames, покрыты fixtures и живыми e2e-пробами.
- `--defer`, `--after`, `wait`, inbox reasons, rate guards и transcript pickup дают для Codex те же
  проверяемые гарантии, что и для поддерживаемых получателей.
- Отказ `agent cannot receive chat` исчезает только после доказанного безопасного detector, а не
  через безусловный send-keys fallback.

Каждое доставленное сообщение явно показывает `provider + host + session` отправителя и несёт
структурированную identity обеих сторон. Поэтому Codex в проекте не может ответить одноимённой или
соседней Claude-сессии только из-за совпадающего cwd.

## План

- [x] Собрать реальные Codex pane frames для idle composer, running turn, approval/menu, partial
  input, queued input, reconnect и rendering transition; сохранить публично безопасные fixtures.
- [x] Реализовать Codex `chatDeliverable`/`inputBusy` только на доказанных состояниях, с fail-closed
  поведением для неизвестного frame.
- [x] Добавить provider-aware chat envelope/sender label и точный reply address; обновить local и
  fleet transport, ledger schema, inbox/outbox и management prompt.
- [x] Подключить Codex к существующим defer/after/wait/rate/retry guarantees без отдельного ledger
  или безусловного pane fallback.
- [x] Пройти живой e2e между двумя managed Codex sessions и cross-provider e2e рядом с Claude в
  одном cwd, включая busy/approval/partial-input negative cases.

## Acceptance

- [x] Delivery происходит только в подтверждённый idle Codex composer и никогда в menu/approval.
- [x] Partial human input не изменяется и не смешивается с agent message.
- [x] Receiver до выполнения видит provider, host, session отправителя и точную команду ответа.
- [x] Claude и Codex одного проекта получают только адресованные им envelopes.
- [x] `wait` завершается по реальной границе turn/transcript, а не по отсутствию знакомого regex.
- [x] Unknown/new Codex UI frame удерживает сообщение в inbox с объяснимой причиной.
- [x] Два read-only валидатора проверили план, затем два — код, fixtures и живой e2e.

## Конвейер 2/2

- [x] Валидатор плана 1: pane state machine и input safety.
- [x] Валидатор плана 2: envelope identity, fleet transport и wait semantics.
- [x] Валидатор реализации 1: fixtures/detectors/negative tests.
- [x] Валидатор реализации 2: живой local/fleet/cross-provider e2e.

## Что сделано

- Existing v2 identity envelope and fleet transport were retained; delivery now uses provider-owned
  structured pane states and exact reply routing for managed Codex recipients.
- Final pane inspection is protected by a tmux input gate, and paste, Enter, and a submission receipt
  execute in one command queue. Partial input, queued input, approval/menu, reconnect, startup, and
  unknown frames hold fail-closed.
- Codex turns carry an immutable message ID. A durable pickup barrier and transcript boundary make
  `wait` survive daemon/session restart without accepting an old answer or duplicating delivery.
- Post-release restart verification also covered a turn interrupted after pickup: its terminal abort
  record now releases the barrier after settle without replaying the old message, and queued mail
  continues on the same resumed identity.
- Real E2E covered two managed Codex identities in both directions, deferred/busy/approval/partial
  and queued states, restart/resume with the same identities, a same-directory cross-provider peer,
  and a bidirectional fleet address. Both implementation validators passed the final code and E2E.
