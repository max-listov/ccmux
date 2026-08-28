---
title: Happy and CodexMonitor — ownership, live state and adoption options
description: Source-level comparison of the requested repositories, their current artifacts, and the separate Happy Agent runtime used by the current desktop client.
type: research
status: active
created: 2026-08-28
updated: 2026-08-28
related:
  - docs/research/2026-08-28-codex-control-and-desktop-coexistence.md
  - docs/research/2026-07-30-t3code-analysis-ideas.md
  - docs/backlog/icebox/2026-08-28-happy-controlled-adoption-pilot.md
  - docs/backlog/in-progress/2026-08-28-owned-codex-app-server-runtime.md
  - docs/backlog/in-progress/2026-08-27-desktop-turn-observation-and-resident-delivery.md
---

# Вывод

Happy действительно близок к идее общего рабочего места для нескольких агентов. Но под этим
именем сейчас находятся **два существенно разных пути**:

1. `slopus/happy`: классический CLI, мобильный/web-клиент и encrypted relay. Команда
   `happy codex` запускает настоящий Codex App Server; Claude имеет local/remote launcher.
2. Актуальный Happy Desktop использует отдельный `slopus/happy-agent`: это собственный
   persistent harness с HTTP/SSE API, а не интерфейс поверх штатного Codex runtime.

CodexMonitor — другой вариант: рабочий desktop-клиент над настоящим Codex App Server,
с remote daemon, но без общей Claude/Codex модели исполнения.

Принятое направление: собственное владение настоящим App Server в CCMux и тонкие клиенты.
Happy и CodexMonitor служат источниками архитектурных приёмов, не устанавливаются и не
заменяют CCMux. Из Happy полезны cursor/generation/reconciliation, из CodexMonitor — обработка
native requests/events. Это не открывает доступ к существующему stdio-only Desktop runtime:
наблюдение уже открытых Desktop conversations остаётся отдельной задачей.

## Что действительно проверено

Обе запрошенные репы склонированы в каталог зависимостей, отдельно от рабочего CCMux checkout.
Зафиксированы HEAD, package metadata, опубликованные releases и registry packages. Исследованы
launch, transport, статус, сообщения, reconnect, resume, permissions и privacy boundaries.
Для зависимости актуального Happy Desktop дополнительно прочитаны публичные исходники/API;
она не устанавливалась и не выдаётся за третий полностью проаудированный проект.

Это **source-level research**, не успешный product E2E. Не выполнялись установка зависимостей,
вход в Happy, pairing, запуск Happy/CodexMonitor, передача им production-разговоров или rollout.
Отдельный read-only пробник исполнил исходную чистую функцию Happy `checkIdleState` в памяти;
его результаты приведены ниже. Он не подменяет проверку живых сессий.

| Источник | Проверенная ревизия / артефакт | Значение |
| --- | --- | --- |
| `slopus/happy` | `7e63b45ac7011a8649e31a4e49353bd5e0927c6b`, commit 2026-08-27 | Изученный clone |
| Happy CLI | registry `happy@1.2.2`, опубликован 2026-08-27 | Имя пакета совпадает с upstream |
| Happy self-host | registry `happy-server-self-host@1.1.11`, 2026-06-10 | Версия не совпадает с новым CLI; совместимость требует проверки |
| Happy Desktop | release `v0.0.76`, 2026-08-27 | Есть macOS arm64/x64 assets |
| Happy Desktop source | `3b4ef23d1fb4f43f2f631bb9d34c1a012755a3aa`, 2026-08-28 | Прочитан отдельно; не приравнивается к release |
| Новый Happy Agent | release `v0.4.22`, 2026-08-27; source `6cb708f700e0594aec089d5fb39d93d3a1857a2f` | Отдельный runtime и repository |
| Новый typed client | registry `@slopus/happy-agent-client@0.0.43` | Не путать с unscoped `happy-agent` |
| Happy Terminal | registry `@slopus/happy-terminal@0.3.4`, Node >=24 | Отдельный клиент нового runtime |
| `Dimillian/CodexMonitor` | `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`, commit 2026-03-26 | Изученный clone; main package 0.7.68 |
| CodexMonitor release | `v0.7.67`, 2026-03-24 | macOS/Linux/Windows assets; iOS описан как WIP |

CodexMonitor не archived, но последний проверенный commit main — мартовский. Дата обновления
GitHub repository metadata не означает свежий код. Совместимость с августовским Codex нельзя
вывести из номера версии самого клиента.

Источники артефактов: [Happy releases](https://github.com/slopus/happy/releases),
[Happy Desktop v0.0.76](https://github.com/slopus/happy-desktop/releases/tag/v0.0.76),
[Happy Agent v0.4.22](https://github.com/slopus/happy-agent/releases/tag/v0.4.22),
[CodexMonitor v0.7.67](https://github.com/Dimillian/CodexMonitor/releases/tag/v0.7.67).

## 1. Классический Happy: что запускается и где живёт беседа

Упрощённая схема именно `slopus/happy`, не нового harness:

```text
Happy mobile / web / controller CLI
                 |
                 | encrypted messages + RPC, Socket.IO / HTTP
                 v
          Happy sync server
                 |
                 v
          daemon на host-A
                 |
          session runner
           /           \
 Claude local/SDK     Codex App Server (stdio)
```

`happy-cli` регистрирует машину и session record. Machine-scoped соединение позволяет
удалённо запускать сессии; session-scoped соединение доставляет ввод и публикует события.
На машине есть локальный HTTP control server, а для удалённых клиентов — RPC через relay.
Это не сервер, исполняющий модели вместо компьютера: provider/tool execution остаётся на хосте.

Важное разделение identity: Happy session ID, machine ID и `codexThreadId` / `claudeSessionId`
— разные поля. Название проекта, title и время активности не заменяют ни одно из них.
Обычный новый запуск генерирует Happy session tag; reconnect использует отдельный путь
восстановления прежнего Happy record и encryption context.

Исходники: [CLI architecture](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/docs/cli-architecture.md),
[daemon](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/daemon/run.ts),
[session client](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/api/apiSession.ts).

### Codex: настоящий App Server, не чтение терминального спиннера

`CodexAppServerClient.connect()` запускает `codex app-server --listen stdio://`.
Используются `thread/start`, `thread/resume`, turn operations и provider notifications.
`runCodex` нормализует события; начало задачи включает `thinking`, завершение/abort выключает.
Проверка окончания очереди отделена от одного завершившегося turn: `ready` отправляется, когда
нет pending work и очередь пуста. Heartbeat с текущим `thinking` идёт каждые 2 секунды.

Это удобная модель управления, но данный stdio принадлежит Happy runner. Другой клиент
подключается к интерфейсу Happy, а не получает автоматически второй вход в тот же stdio.
В этом Codex path нет Claude-переключателя между штатным интерактивным TUI и remote launcher.

Исходники: [App Server transport](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/codex/codexAppServerClient.ts),
[Codex loop](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/codex/runCodex.ts),
[ready boundary](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/codex/emitReadyIfIdle.ts).

### Claude: переключение launcher, а не два независимых writer

`loop.ts` переключает local и remote launcher. Local запускает интерактивный Claude;
remote использует официальный Claude Agent SDK и provider resume. Этот переход необходимо
проверять отдельно от закрытия одного UI. README-фраза о переключении по клавише не доказывает
ни отсутствие прерывания текущего turn, ни работу такого режима для Codex.

В `claudeRemote` невалидная локальная сохранённая сессия может обнулить `startFrom` перед
построением SDK options. Поэтому строгий identity-pinned consumer не должен заимствовать
этот fallback без проверки. У Codex `resumeExistingThread` ошибка resume пробрасывается;
это полезное отличие, но возвращённый UUID всё равно стоит проверять против запрошенного.

Исходники: [Claude loop](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/claude/loop.ts),
[remote launcher](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/claude/claudeRemote.ts),
[SDK adapter](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/claude/sdk/query.ts),
[Codex resume](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/codex/resumeExistingThread.ts).

### Persistence и restart

Daemon сохраняет metadata и ключевой материал для reconnect в локальном session store.
После перезапуска он читает сохранённые записи; `happy resume <happy-id>` строит запуск с
provider resume ID и прежним Happy encryption context. Это полезный механизм восстановления.
Однако сохранённый record не доказывает, что process жив, а resume не продолжает прерванный
in-flight model request без нового turn.

Встроенный `daemon install` ограничен macOS и требует elevated privileges; сам macOS source
помечает этот путь как неиспользуемый в пользу автозапуска при вызове CLI. Нельзя считать это
доказанным boot-time self-healing на всех машинах. Такой gate остаётся у пилота.

Источники: [resume command](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/resume/handleResumeCommand.ts),
[install boundary](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/daemon/install.ts),
[macOS install](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/daemon/mac/install.ts).

## 2. Статусы Happy: готовый UI полезен, CLI нельзя считать oracle

UI имеет явный приоритет: disconnected → permission required → input required → thinking
или waiting. Это ближе к нужной модели, чем один boolean `active`.
Но источник `active` — presence, не выполнение модели. Server хранит last-active, а свежий
`thinking` приходит отдельным ephemeral событием. В исследованном server timeout path
неактивность определяется после 10 минут тишины с минутным циклом проверки. Это не измеренный
UI latency и не доказательство соблюдения CCMux 5-second TTL.

Исходники: [UI resolver](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-app/sources/sync/sessionState.ts),
[presence handler](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts),
[timeout loop](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-server/sources/app/presence/timeout.ts).

`packages/happy-agent` в этой же репе — небольшой **controller CLI**, не новый Happy Agent
daemon из другого repository. Он умеет machines/list/status/spawn/send/history/stop/wait.
Prefix resolution отвергает неоднозначные совпадения. JSON formatter исключает encryption keys.
Но у этой поверхности есть конкретные ограничения:

- `waitForIdle` проверяет `controlledByUser` и pending requests, а не `thinking` или heartbeat.
- `status` ждёт metadata/state update до 3 секунд. В text mode сообщает о cached fallback,
  но JSON branch не добавляет `liveData`/freshness marker.
- `send --wait` наблюдает turn-start/turn-end/ready, но не связывает результат с уникальным
  ID именно отправленного сообщения. Окончание другой уже выполнявшейся задачи требует теста.
- Обычный send отправляет Socket.IO event и ждёт 500 мс перед закрытием. Это не end-to-end ack.
  Отправляемый controller message не получает `localId` в этом методе.
- В отличие от controller, provider-side outbox имеет `localId`, HTTP batches и receive cursor
  для catch-up. Эти две реализации нельзя смешивать в обещание exactly-once delivery.

Read-only пробник выполнил **не переписанную модель**, а извлечённую из pinned source чистую
функцию `checkIdleState`, транспилированную Bun в памяти:

| Вход | Результат |
| --- | --- |
| нет agentState | `false` |
| remote, `controlledByUser=false`, requests пусты | `true` |
| есть pending request | `false` |
| metadata lifecycle archived | `archived` |

У функции вообще нет входа `thinking`. Следовательно, remote state без approval недостаточно
для доказательства idle. Это подтверждённый предел функции, не воспроизведение полного UI bug.

Источники: [controller wait/send](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-agent/src/session.ts),
[commands](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-agent/src/index.ts),
[safe JSON output](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-agent/src/output.ts).

### Не устанавливать unscoped happy-agent из registry

На дату проверки registry `happy-agent@0.1.5` описывает другой Claude SDK server с JWT/HTTP
callback и executable `dist/cli.js`. В исследованной репе controller имеет version `0.1.0`
и executable `bin/happy-agent.mjs`. Это другой package artifact, а не подтверждённый релиз
изученного controller. Название команды в README не устанавливает происхождение пакета.

Правильный новый typed client имеет scoped имя **`@slopus/happy-agent-client`** и ссылается на
`slopus/happy-agent`. Для пилота старого controller потребуется воспроизводимый build из
зафиксированного источника либо проверенный upstream artifact, не установка по совпавшему имени.

Источники: [registry happy-agent](https://registry.npmjs.org/happy-agent/latest),
[controller package](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-agent/package.json),
[scoped client registry](https://registry.npmjs.org/@slopus/happy-agent-client/latest).

## 3. Privacy, permissions и self-host классического Happy

Клиенты шифруют messages, session metadata и agent state. Есть per-record data keys и legacy
режим; при pairing передаётся доступ к ключам. Relay хранит ciphertext, однако IDs, timestamps,
presence/usage и push metadata не становятся тайной только потому, что transcript encrypted.
При интеграции собственный reader становится доверенным клиентом с decryption capability.

README-заявление об отсутствии telemetry расходится с `PRIVACY.md` от 2026-07-23: там описаны
PostHog analytics с opt-out, RevenueCat и optional ElevenLabs voice. Voice получает аудио и
часть текстового контекста вне E2EE sync boundary. Не включать голос автоматически и не
переносить эти выводы без проверки на отдельный новый desktop/harness продукт.

Источники: [privacy policy](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/PRIVACY.md),
[encryption implementation](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-app/sources/sync/encryption/encryption.ts),
[wire protocol](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/docs/protocol.md).

Pairing — это доступ к управлению машиной, не только к просмотру: common RPC handlers содержат
shell и file operations. В Codex path есть отдельный Happy sandbox и native permission mapping.
При Happy-managed sandbox native Codex получает `approvalPolicy=never`/`danger-full-access`,
а граница безопасности переносится наружу. Без понимания этого нельзя обещать сохранение
всех native approval semantics или выбирать yolo для удобства демонстрации.

Источники: [common RPC](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/modules/common/registerCommonHandlers.ts),
[Codex policy](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/codex/executionPolicy.ts).

`happy server` имеет self-host путь с PGlite и локальными uploads. По умолчанию wrapper выбирает
loopback; direct standalone entrypoint имеет другой host default. Wrapper предлагает записать
server/webapp URL в Happy settings и отказывает non-interactive запуску без явного выбора;
`--no-persist` исключает эту запись. Он всё равно создаёт server state и выполняет migrations.
Это не read-only preview. Self-host artifact от июня и CLI от августа требуют version-pair E2E.
Controller config отдельно читает env/default URL и не наследует автоматически CLI settings.

Источники: [server command](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-cli/src/commands/server.ts),
[standalone server](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-server/sources/standalone.ts),
[controller configuration](https://github.com/slopus/happy/blob/7e63b45ac7011a8649e31a4e49353bd5e0927c6b/packages/happy-agent/src/config.ts).

## 4. Новый Happy Desktop + Happy Agent: самый интересный, но иной путь

Текущий Desktop source использует `@slopus/happy-agent-client`, скачивает runtime из
`slopus/happy-agent/releases`, проверяет артефакт и подключается к authenticated Unix socket.
Закрытие обычного client connection намеренно не останавливает daemon. Это правильное
разделение UI и долгоживущей работы. Main содержит transport/terminal bridging; renderer
использует typed API. Это не `packages/codium` из первого clone и не старый controller CLI.

В опубликованном Desktop `v0.0.76` release note указан client `0.0.38`, тогда как проверенный
main уже использует `0.0.43`. Не утверждать, что скачанный release содержит весь сегодняшний API.

Источники: [desktop dependency](https://github.com/slopus/happy-desktop/blob/3b4ef23d1fb4f43f2f631bb9d34c1a012755a3aa/packages/happy-desktop-electron/package.json),
[local attachment](https://github.com/slopus/happy-desktop/blob/3b4ef23d1fb4f43f2f631bb9d34c1a012755a3aa/packages/happy-desktop-electron/sources/main/localHappyAgent.ts),
[Unix client](https://github.com/slopus/happy-desktop/blob/3b4ef23d1fb4f43f2f631bb9d34c1a012755a3aa/packages/happy-desktop-electron/sources/main/happyAgentDaemonClient.ts),
[release downloader](https://github.com/slopus/happy-desktop/blob/3b4ef23d1fb4f43f2f631bb9d34c1a012755a3aa/packages/happy-desktop-electron/sources/main/happyAgentRelease.ts).

### Главное отличие: это замена agent harness

Новый Happy Agent сам владеет agent loop, tools, permissions, compaction и SQLite persistence.
Codex-shaped provider не запускает штатный Codex App Server: он строит запросы через собственный
provider layer. Проверенный `createCodexClient` создаёт OpenAI client с выбранным endpoint и
credential. Claude path использует SDK для inference, но заменяет встроенные tool/skill/session
поверхности своими. Это прямо заявлено upstream и согласуется с прочитанным provider source.

Значит, можно получить единый интерфейс и API, но нельзя автоматически получить ту же native
Codex conversation, встроенные Desktop tools, официальный skill/plugin lifecycle и идентичное
поведение компакции. Happy session ID не становится native Codex UUID от похожего имени модели.
Такой выбор — переход на другой harness, а не просто смена окна.

Источники: [Happy Agent architecture](https://github.com/slopus/happy-agent/blob/6cb708f700e0594aec089d5fb39d93d3a1857a2f/docs/architecture.md),
[provider client](https://github.com/slopus/happy-agent/blob/6cb708f700e0594aec089d5fb39d93d3a1857a2f/packages/happy-providers/sources/vendors/codex/impl/createCodexClient.ts),
[provider package](https://github.com/slopus/happy-agent/blob/6cb708f700e0594aec089d5fb39d93d3a1857a2f/packages/happy-providers/package.json).

### Что особенно полезно перенять

Typed client документирует HTTP reads и SSE с cursor, reconnect/backoff, daemon identity,
`state_lost` и authoritative refetch. `HappyReducer` открывает stream до snapshot, ограничивает
параллельные загрузки, согласует версии и игнорирует поздние ответы после stop.
Текстовые deltas имеют offset и явный reconcile при дыре. Это ровно те механизмы, которые
нужны живому fleet UI; одного socket-connected недостаточно.

API хорош как источник паттернов или как реальный dependency при выборе этого harness.
Подключить его к CCMux без соответствующего Happy daemon нельзя: схема принадлежит тому
runtime. Гарантии из README/API ещё должны пройти наш restart/network/approval E2E.

Источник: [typed client contract](https://github.com/slopus/happy-agent/blob/6cb708f700e0594aec089d5fb39d93d3a1857a2f/packages/happy-agent-client/README.md).

Текущий Happy Agent README описывает mobile sync как включённую machine-level интеграцию,
которая при старте может импортировать имеющиеся Happy credentials; без credential pairing
всё равно остаётся отдельным действием. Desktop README рекламирует local-first режим.
Пилот обязан проверить точный build и настройки, а не объявлять весь бренд ни всегда cloud,
ни всегда полностью offline. Remote SSH path описан upstream как существующий transport
с ещё незавершённым polished multi-host UX. Полноту fleet UI пока не считаем доказанной.

Источники: [Happy Agent README](https://github.com/slopus/happy-agent/blob/6cb708f700e0594aec089d5fb39d93d3a1857a2f/README.md),
[Happy integration and boundaries](https://github.com/slopus/happy-agent/blob/6cb708f700e0594aec089d5fb39d93d3a1857a2f/docs/happy.md).

## 5. CodexMonitor: сильный native Codex client

React/Tauri UI вызывает Rust backend. Общая backend core используется desktop и headless
daemon. Workspace session запускает настоящий `codex app-server`, читает JSON-RPC stdout,
коррелирует request IDs и маршрутизирует события по workspace/thread. Встречаются shared
workspace mappings, поэтому формулу «строго один process на каждую папку» не следует
превращать в инвариант поверх README.

В UI есть approvals, user-input requests, queue/steer, turn interruption, diff/files/Git,
модель и effort. Native `thread/status/changed` влияет на processing state, а turn completion
проверяет current turn ID, чтобы завершение старого turn не выключило новый.

Источники: [workspace transport](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/backend/app_server.rs),
[shared operations](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/shared/codex_core.rs),
[turn reducer](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src/features/threads/hooks/useThreadTurnEvents.ts).

### Remote mode и ограничения для fleet

Desktop может работать клиентом standalone daemon; transport — newline JSON RPC через TCP.
Daemon требует token, если явно не выбран insecure mode. Проверенный TCP transport не добавляет
TLS сам: нужен защищённый сетевой путь, например SSH/tailnet, а не открытый публичный listener.
RPC включает file/Git/control mutations, поэтому token — не read-only monitoring credential.

Настройки хранят несколько remote targets, но runtime connection выбирает один active backend.
Это не доказанная одновременная агрегация всех хостов. Remote transport сбрасывает pending
requests на disconnect и повторяет только выбранные операции, не произвольный send.
Event forwarder при broadcast lag делает `continue`: bounded replay/gap notification на этом
уровне отсутствует. Для production live-count необходима отдельная проверка восстановления.

Источники: [daemon transport](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/bin/codex_monitor_daemon/transport.rs),
[event forwarding](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/bin/codex_monitor_daemon/rpc.rs),
[remote client](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/remote_backend/mod.rs),
[TCP transport](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/remote_backend/tcp_transport.rs).

### Почему это не reader существующих официальных Desktop сессий

README прямо разделяет обнаружение CLI history по `cwd` и live stream после resume.
Выбор thread вызывает `thread/resume` в runtime CodexMonitor. Это не пассивная подписка на
чужой Desktop writer. Более того, `thread_live_subscribe_core` в изученном source только
проверяет thread ID и наличие workspace session; название операции не доказывает attachment.

Приложение также синхронизирует feature settings в Codex config при загрузке/сохранении.
Поэтому даже GUI-пилот требует изоляции конфигурации и отсутствия чужих активных writer.
Worktree/clone функции опциональны; для проверки не нужны дополнительные checkout репозитория.

Источник: [README notes](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/README.md).

## 6. Подписки и сохранение native возможностей

Codex поддерживает ChatGPT login для subscription access и API key для usage-based access.
Native App Server можно использовать без обязательного перехода на отдельную API-оплату.
Состояние конкретного login проверяется в выбранном runtime; название клиента этого не доказывает.
[Официальная authentication documentation](https://learn.chatgpt.com/docs/auth).

Anthropic в актуальном уведомлении приостановила объявленное изменение SDK billing:
Agent SDK, `claude -p` и соответствующие third-party apps пока используют subscription limits.
Поэтому утверждение «любой SDK всегда только за API-деньги» сейчас неверно.
Это не отменяет terms, limits и требований к обращению с credentials.
[Текущая политика Claude Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

Нативный бинарник и новый harness, самостоятельно использующий provider credentials, — разные
интеграционные решения. Поддержку и допустимость конкретного стороннего Codex transport нельзя
вывести из документации о native login. Для минимального расхождения с провайдером предпочтителен
настоящий App Server; перенос credentials в новый harness не был выполнен этим исследованием.

## 7. Выбор пути

| Путь | Что сохраняем | Что получаем | Главная цена / неизвестность |
| --- | --- | --- | --- |
| Официальный Desktop + внешний CCMux observer | Нативный UX и native tools | Статусы там, где доступен тот же runtime | Нет доказанного внешнего доступа ко всем stdio-only Desktop runtimes |
| CCMux-owned App Server + тонкий UI | Настоящий Codex, UUID, provider protocol | Собственный lifecycle и native события | Подключение официального Desktop к этому owner всё ещё отдельный gate |
| Классический Happy | Native Codex App Server; Claude local/SDK path | Готовые mobile/web и remote messaging | Другая presence/wait семантика, relay и дополнительный lifecycle |
| Новый Happy Desktop + Happy Agent | Provider model/access, но другой harness | Общий UI/API, persistent daemon, durable events | Native identity/tools parity и поддержка transport не гарантированы |
| CodexMonitor | Настоящий Codex App Server | Desktop workspace UI, remote daemon | Codex-only, мартовский release, не готовый all-host live fleet |
| T3 Code | Собственный app-server client/runtime split | Полезный образец web-архитектуры | Не мост к уже открытой официальной Desktop сессии |

Практический порядок:

1. Добавить opt-in owned App Server в CCMux, сохраняя обычные TUI-сессии и provider identity.
2. Читать native события в resident projection: generation, cursor, expiry и reconciliation.
   Один provider process остаётся единственным writer; число клиентов не умножает процессы.
3. Подключить существующие `msg`/`wait`, точную reply identity, подтверждения и thin clients.
   Не переносить чужой UI/backend stack, inference transport, relay или replacement harness.
4. Existing official Desktop observation продолжать в текущей задаче. Никакой новый
   controllable runtime не закрывает acceptance старых Desktop conversations.

Оба запрошенных проекта MIT; при копировании существенных частей сохраняются необходимые
copyright/license notices. Новый Happy Agent имеет также third-party notices для адаптированных
частей. Исследование само по себе не добавляет dependency и не меняет лицензию CCMux.

## 8. Что можно использовать сейчас и что ещё не доказано

Есть готовые опубликованные macOS installers обоих клиентов. Для Happy CLI существует
проверенный registry artifact `happy@1.2.2`. Новый Happy Desktop умеет сам получать свой
runtime; это действие имеет setup/config/credential последствия, поэтому не выполнено
в рамках чтения исходников. Старый controller из source нельзя заменять чужим npm package.

Пилот должен дать реальные цифры и доказательства по следующим пунктам:

- одна и та же session identity в UI, CLI и API; для native path — настоящий provider UUID;
- working → approval/input → working → idle, stop и interruption;
- два concurrent sender, duplicate/retry и ack именно нужного turn;
- client exit, daemon/provider restart, reconnect gap и потеря одного remote host;
- latency и expiry положительных статусов, 15-минутные CPU/RSS измерения;
- provider subscription mode, tools/skills/config fidelity и отсутствие второго writer;
- реальные network destinations, opt-out, ключи, pairing/revocation и cleanup.

Ранее выполненный shared App Server эксперимент в
[отдельном исследовании](2026-08-28-codex-control-and-desktop-coexistence.md) доказывает
возможность CLI/RPC управления одной native test identity. Он не тестировал Happy или
CodexMonitor и не доказал live attachment официального Desktop. Эти границы сохраняются.

## Записанные задачи

- [Happy adoption pilot — замороженная альтернатива](../backlog/icebox/2026-08-28-happy-controlled-adoption-pilot.md).
- [Opt-in owned native Codex App Server](../backlog/in-progress/2026-08-28-owned-codex-app-server-runtime.md).
- [Существующий Desktop observer](../backlog/in-progress/2026-08-27-desktop-turn-observation-and-resident-delivery.md)
  связан с этим исследованием; новая дублирующая задача не создавалась.

Статус исследования: source audit завершён; запуск Happy/CodexMonitor и их product E2E не
выполнялись. Принята собственная native реализация CCMux, её доказательства и lifecycle
находятся в связанной implementation task. Happy adoption не входит в этот scope.
