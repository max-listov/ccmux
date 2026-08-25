---
title: Довести inter-agent chat для managed Codex-сессий
description: Научить ccmux безопасно доставлять msg в Codex TUI и ждать настоящую границу хода
type: task
status: icebox
created: 2026-08-10
updated: 2026-08-25
defrost: по решению владельца. Работа не заблокирована — не хватает только живых Codex frames и e2e; размораживать, когда Codex-сессии реально понадобятся в переписке, а не «чтобы было».
---

> **Заморожено 2026-08-25 по решению владельца.** Ничем не заблокировано и полностью описано;
> цена — сбор живых Codex frames, fixtures и e2e, то есть дни, а не часы. До разморозки
> `ccmux msg` продолжает честно отказывать Codex-получателю, а не доставлять вслепую.

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

- [ ] Собрать реальные Codex pane frames для idle composer, running turn, approval/menu, partial
  input, queued input, reconnect и rendering transition; сохранить публично безопасные fixtures.
- [ ] Реализовать Codex `chatDeliverable`/`inputBusy` только на доказанных состояниях, с fail-closed
  поведением для неизвестного frame.
- [ ] Добавить provider-aware chat envelope/sender label и точный reply address; обновить local и
  fleet transport, ledger schema, inbox/outbox и management prompt.
- [ ] Подключить Codex к существующим defer/after/wait/rate/retry guarantees без отдельного ledger
  или безусловного pane fallback.
- [ ] Пройти живой e2e между двумя managed Codex sessions и cross-provider e2e рядом с Claude в
  одном cwd, включая busy/approval/partial-input negative cases.

## Acceptance

- [ ] Delivery происходит только в подтверждённый idle Codex composer и никогда в menu/approval.
- [ ] Partial human input не изменяется и не смешивается с agent message.
- [ ] Receiver до выполнения видит provider, host, session отправителя и точную команду ответа.
- [ ] Claude и Codex одного проекта получают только адресованные им envelopes.
- [ ] `wait` завершается по реальной границе turn/transcript, а не по отсутствию знакомого regex.
- [ ] Unknown/new Codex UI frame удерживает сообщение в inbox с объяснимой причиной.
- [ ] Два read-only валидатора проверили план, затем два — код, fixtures и живой e2e.

## Конвейер 2/2

- [ ] Валидатор плана 1: pane state machine и input safety.
- [ ] Валидатор плана 2: envelope identity, fleet transport и wait semantics.
- [ ] Валидатор реализации 1: fixtures/detectors/negative tests.
- [ ] Валидатор реализации 2: живой local/fleet/cross-provider e2e.
