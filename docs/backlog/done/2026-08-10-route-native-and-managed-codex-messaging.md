---
title: Развести native Desktop и ccmux messaging
description: Зафиксировать capability-based routing между Desktop tasks и persistent managed sessions
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:15 +07:00
---

## Зачем

Desktop tasks уже умеют штатно перечислять peers, читать их, отправлять follow-up и ждать ответ.
Живой e2e подтвердил отдельный turn с сохранённым source thread. Дублировать этот transport внутри
ccmux не нужно: второй ledger и вторая адресация создадут рассинхрон и конфликт ownership.

Одновременно обычный Codex CLI не получает Desktop task tools, а ccmux-managed fleet имеет другие
гарантии: tmux persistence, daemon self-heal, fleet addresses, outbox/retry, Telegram, wait и router.
Без явного routing rule агент легко выбирает неверный канал только потому, что видит transcript или
знает thread id.

## Результат

- Документация однозначно направляет Desktop-to-Desktop через native thread tools, а managed
  CLI-to-CLI через `ccmux msg/wait/transcript`.
- Видимый внешний thread не считается writable без проверки source и active owner.
- ccmux не дублирует Desktop task bus и не обещает управлять Desktop-owned runtime.
- Management prompt учит capability-based выбору канала без private host/session examples.
- Есть короткая диагностическая таблица: где искать peer, каким transport писать, как ждать ответ
  и что означает `active`, `idle` и `notLoaded` в каждой среде.

Каноническая identity сообщения структурирована как минимум как
`agent/provider + machine/host + session/thread identity`; `cwd`, имя проекта и похожее название
сессии являются только display metadata. При наличии Claude и Codex в одном проекте transport не
может выбирать получателя по директории или «ближайшему» имени. Получатель видит provider/source
отправителя и точный обратный адрес.

## План

- [x] Ввести named Zod schemas для managed peer/principal/envelope: managed identity =
  `source + machine + agent + session + thread UUID`; `cli`/`owner` — отдельные principal variants,
  а provider, runtime source и capability не смешиваются.
- [x] Перевести registry на явный `agent` без implicit Claude/pipe legacy parsing; selector
  `machine:session` резолвится один раз, а immutable envelope пинит UUID/provider обеих сторон.
- [x] Сделать чистый state protocol cutover: старый неявный ledger/outbox bundle не обогащается
  догадками и не читается новым delivery как параллельный API.
- [x] Перевести local/remote send, transport-only receive, outbox retry, cursors/acks/dedup,
  stop-hook/daemon delivery, inbox/log/Telegram на один immutable envelope; receive повторно
  проверяет exact target tuple перед append/inject.
- [x] Развести Desktop-native и ccmux-managed маршруты в management prompt, help/README и
  architecture docs; неизвестный или смешанный ownership должен fail-first.
- [x] Добавить exact provider/source/UUID в sender label и reply command; `onBehalfOf` остаётся
  отдельной authority provenance и не участвует в route resolution.
- [x] Показывать agent в managed `list`/`fleet` human+JSON surfaces; external Codex discovery и
  ownership остаются в отдельной зависимой задаче.
- [x] Исключить `restart --then` из peer handoff и публичного API; raw `send` остаётся только
  keypress transport.
- [x] Проверить negative matrix: same cwd, reused name/provider mismatch, same name на двух машинах,
  retry после reuse, self-set transport env, mixed-version receiver и Desktop zero-ledger.

## Acceptance

- [x] Ни один routing path не выводит адресата только из cwd/project name.
- [x] Chat envelope runtime-валидирован и несёт полный pinned managed endpoint обеих сторон;
  `cli`/`owner` не получают fake provider, старый неявный формат не остаётся параллельным API.
- [x] Receiver видит source/provider, host, session и thread UUID отправителя до выполнения задачи,
  включая local delivery, и получает exact pinned reply command.
- [x] Desktop-owned task не попадает в ccmux ledger, managed session не адресуется Desktop-only
  tool без подтверждённой capability.
- [x] Коллизия identity приводит к явной ошибке с кандидатами, а не к выбору Claude или Codex по
  умолчанию.
- [x] Pending/retry никогда не доставляется сессии, переиспользовавшей имя с другим UUID/provider;
  missing/mixed-version identity отвергается до append.
- [x] В новом delivery/cursors/acks/dedup нет name-only match; registry provider всегда явный.
- [x] `restart --then` не остаётся вторым name-only handoff path: API и outbox variant удалены.
- [x] Новые public docs/examples проходят sanity-check на private host/session/path/thread tokens.
- [x] Два read-only валидатора проверили план, затем два — реализацию и e2e.

## Конвейер 2/2

- [x] Валидатор плана 1: потребовал pinned UUID/provider, чистый state cutover и fail-closed v2
  remote receive вместо name-only retry.
- [x] Валидатор плана 2: разделил provider/source/capability, добавил managed surfaces,
  `restart --then`, Desktop zero-ledger и cross-version negative matrix.
- [x] Валидатор реализации 1: PASS после проверки schema/callsites/cutover и negative routing tests.
- [x] Валидатор реализации 2: PASS после проверки prompts/docs, provenance и capability boundaries.

## Правки валидатора-1

- Managed identity включает source, machine, agent, session и UUID; имя — selector/display, не
  durable delivery key.
- Ledger и outbox используют один immutable envelope; receiver атомарно сверяет target tuple,
  retry не резолвит адрес заново.
- Неизвестный legacy ledger нельзя достоверно дополнить provider/UUID: нужен явный clean cutover,
  а cross-version wire обязан fail до append.
- Registry не может выводить authoritative provider из implicit Claude default.

## Правки валидатора-2

- Desktop-native bus и ccmux-managed ledger — независимые sources of truth; transcript visibility
  не означает write capability.
- Managed `list`/`fleet`, prompt, labels, inbox/log/Telegram и remote retry обязаны показывать и
  сохранять provider identity; external Codex UI остаётся зависимой discovery-задачей.
- Live Codex pane injection остаётся зависимой chat-задачей; здесь проверяется routing admission и
  envelope, а не ещё не откалиброванный detector.

## Правки валидаторов реализации

- Починен реальный `ccmux new`: `--agent claude|codex` пишет обязательный provider; отсутствующее
  значение падает до registry append.
- `restart --then` удалён целиком вместо сохранения второго name-only peer transport.
- Remote receive получил межпроцессный lock вокруг check+append; конкурентные retries одного UUID
  дают одну ledger row.
- Managed sender требует вращаемую capability runtime-процесса; самодельный `CCMUX_SESSION` не
  повышает CLI до managed identity. Remote admission проверяет реальную ancestry до `sshd`, а не
  подделываемый `SSH_CONNECTION`.
- README/help/prompt синхронизированы с v2 wire/state и честно отмечают: managed Codex identity уже
  поддержана, pane delivery остаётся зависимой задачей.

## Что сделано

- [x] Shared: `ManagedPeer`, principals и immutable `ChatMessage` определены Zod-схемами в
  `src/config/schema.ts`; registry требует explicit `agent`, message id — UUID.
- [x] Routing/storage: `src/commands/msg.ts`, `src/chat/store.ts`, `src/fleet/outbox.ts` и
  `src/fleet/flush.ts` используют pinned envelope, exact endpoint validation и atomic retry dedup.
- [x] Provenance: `src/chat/auth.ts` вращает capability managed runtime и проверяет SSH ancestry для
  transport-only receive.
- [x] Surfaces: provider/source/thread доступны в `list`, `fleet`, inbox/log/Telegram, injected label
  и exact reply command; unknown remote provider не становится Claude.
- [x] Boundaries/docs: Desktop-native остаётся zero-ledger; модель и capability table описаны в
  `docs/architecture/peer-routing.md`, README и management prompt.
- [x] Lifecycle safety: `restart --then` и его outbox/log variants удалены; handoff идёт через `msg`.
- [x] Tests: `bun run check` — TypeScript green, 344 tests passed; отдельные tests покрывают real
  `new --agent codex`, forged provenance, stale identity, v1 refusal, Desktop zero-ledger и восемь
  конкурентных receiver processes.
- [x] Не делалось: Codex pane injection и external Codex ownership — вынесены в зависимые backlog
  tasks; release/deploy не выполнялись.
