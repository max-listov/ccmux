---
title: Управляемый стенд удержания и доставки
description: Изолированная проверка native owner delivery через production control contract без внешней модели.
status: active
created: 2026-09-27 19:21 +07:00
updated: 2026-09-27 20:42 +07:00
type: architecture
---

# Граница стенда

`test/controlled-delivery.test.ts` использует настоящий Unix control server/client,
аутентификацию собственной fixture-сессии, admission, ledger, daemon delivery,
Codex owner, mailbox, operation journal, monitoring publisher и `ContentProducer`.
Provider events проходят через `observeCodexContent`, затем coalescing writer с notice-файлом;
initial content flush предшествует live status. Меню рисуется в отдельном
tmux server. Только внешний Codex provider заменён явным симулятором RPC/events;
реальная модель, аккаунт и Desktop App Server не вызываются.

Тест не записывает hold, cursor, ack или operation receipt вручную. Их создаёт production
код после настоящего чтения панели и обработки provider-ответа. Этот сценарий проверяет
CCMux, а не поведение реального провайдера или готовность конкретного consumer UI.

Native menu hold публикуется как `kind: other` с причиной меню в `text`. На стадии удержания
`state: uncertain`, `turnId: null`: mailbox уже создан, provider turn ещё не начат.
После снятия меню — `admitted`, затем `completed`, `hold: null`, один неизменный turn ID.
Событие `resumed` для снятия message hold не требуется и не подделывается.

# Автоматический прогон

Из source checkout:

```sh
bun test --timeout 20000 test/controlled-delivery.test.ts
```

Последняя JSON-строка содержит message ID, registration generation, receipts стадий,
их timestamps, native content обеих стадий, `provider: simulated` и число provider starts.
`native.read` на held возвращает пустой live frame с sequence 0, на completed — assistant
и terminal для того же turn. Cursor held читает ровно эти два новых records, повтор cursor
completed — пустой delta. Проверяются отрицательные контроли: неизвестный message ID
не имеет evidence, чужой thread ID отклоняется; меню допускает ноль starts даже после
повторного delivery pass; повтор принятого message ID не создаёт второй turn.

# Управляемая проверка consumer

1. Запустить стенд из source checkout:

```sh
CCMUX_HELD_FIXTURE_INTERACTIVE=1 bun test --timeout 650000 test/controlled-delivery.test.ts
```

На `held` он печатает путь `manifest` к временному `consumer.json` и ждёт Enter,
обновляя owner liveness, hold и session snapshot. Каждая остановка ограничена пятью минутами.
Переменная читается только тестом, не runtime: production toggle отсутствует.

2. В другом терминале прочитать live contract, подставив напечатанный manifest:

```sh
bun test/fixtures/readControlledDelivery.ts /tmp/<fixture>/consumer.json
```

Manifest содержит параметры `createControlClient` и exact `message.operation` input.
Он имеет mode `0600`, лежит в изолированном временном каталоге и содержит credential
только собственной fixture-сессии. Не публиковать файл или credential; stdout reader
показывает только session snapshot, operation evidence и native content.

Consumer test adapter может использовать тот же manifest и существующий control client.
Подключение выполняется в тестовой конфигурации consumer, без замены production endpoint.
Проверить список и открытый разговор на held evidence одного exact message ID.

3. Нажать Enter в терминале стенда.

Он снимает fixture-меню, выполняет настоящую owner-доставку и останавливается на `completed`.
Повторный read должен показать тот же message ID, ненулевой turn ID и `hold: null`.
В consumer проверить обновление без reload. Этот шаг UI выполняется и фиксируется самим consumer;
зелёный owner-тест не является доказательством UI или голосовой доставки.

4. Нажать Enter второй раз.

Стенд проверяет idempotency и закрывает свои clients, servers, tmux и временный каталог.
Обработанный SIGINT/SIGTERM и таймаут ожидания также проходят cleanup. SIGKILL обойти невозможно.
Пользовательский daemon и пользовательские сессии не перезапускаются.
