---
title: Права делегированных executors и обратимый сон
description: Create-time authority, native policy evidence, idle CAS и продолжение той же identity.
type: architecture
status: active
created: 2026-10-15 08:00 +07:00
updated: 2026-11-27 09:30 +08:00
---

## Authority до первого prompt

`session.create.delegation` принимает exact parent target и registrationGeneration,
immutable policy и необязательный deadlineAt. Корневые права объявляет host через
`machine.json.delegationAuthorities`; active parent должен совпасть целиком. Дети
наследуют принятый grant родителя и могут только сузить access, canonical workspace
и deadline. Prompt, display name, caller flags и состояние bypass не создают authority.
Неизвестный parent, расширение прав, full-access, TUI и unsupported provider отказывают
до reservation. Claude поддерживает read-only; Codex — read-only и workspace-write.

Policy явно содержит `readScope: host` и `network: false`. Workspace ограничивает
запись; контракт не обещает изоляцию чтения внутри workspace. Read-only Claude имеет
только Read/Glob/Grep, без shell, MCP, plugins, native children и наследуемых settings.
PreToolUse hook отказывает любому другому инструменту, включая auto-allowed вызовы.
Owner ждёт native acknowledgement hooks и отсутствие MCP до applied evidence.

Codex задаёт native sandbox и approvalPolicy never, отключает MCP servers/plugins,
apps, web search и multi-agent. Owner проверяет фактический native sandbox ответа и
повторяет sandboxPolicy, cwd и runtimeWorkspaceRoots при каждом turn/start.
Native runtimeWorkspaceRoots задаются явно; cwd один их не материализует. Acknowledgement
проверяет exact cwd и runtime roots, запрет сети/tmp и отсутствие внешних legacy writableRoots.
Legacy additional roots могут быть пустыми: это отдельное поле native API, а не runtime roots. Делегированный Codex работает headless.
Code-mode helper предварительно запускается native prewarm до baseline ownership;
появление нового процесса после baseline блокирует sleep, а не попадает в whitelist.

Принятый create request сохраняет requestId, raw request, policy digest, lineage и
registration. Неизменённый повтор возвращает того же child, даже после expiry grant;
изменённый повтор отказывает. Cold resume снова проверяет immutable policy. Applied
receipt публикуется только после native acknowledgement; stale/dead runtime даёт unavailable.
У нового delegated Claude owner явно выбирает опубликованный provider alias default,
если caller не выбрал модель, и проверяет его по native catalog до admission.

`delegation.cancel` требует exact parent/child registrations и operationId. Durable stop
записывается до ожидания release, включая sleeping child и caller abort во время create.
Owner проверяет stop/deadline до первого prompt, turn/start/queue push и в resident loop.
Отмена ждёт исчезновения собственных PID со startTime, не сигналит процессы по имени.
PID reuse не расширяет множество потомков. Неизвестная ownership даёт pending/refusal.

## Parent вне managed registry

`delegation.application.capabilities` показывает только bindings, доступные текущему
service caller. `machine.json.applicationDelegationAuthorities` задаёт exact application
binding (`applicationId/channelId/actor: agent/revision`), максимальную policy, leaseMs
(до 60 секунд) и lifetimeMs (до суток). Binding должен также пройти обычный
`messageApplications` caller/channel/actor admission. Отдельный applicationId для агента
позволяет сохранить human/composer binding узким. Настройка host применяется при рестарте.

Trusted backend приложения вызывает `delegation.application.open` после проверки active
аутентифицированного run и реальной цитаты human input в своём журнале. Эти поля не
должны приходить из model tool arguments. Запрос несёт conversationId, runId,
sourceMessageRef, authorizationQuote и operationId. CCMux хранит их с явным assurance
`application-attested`: он доверяет объявленному service backend, не утверждает, что
сам проверил чужой журнал или владеет процессом native parent. Same-user IPC и
аутентифицированный caller узла — граница доверия; поля application не отдельные credentials.

Ответ содержит parent.target.kind `application`, authorityId и generation. Это lease
полномочий, а не Session: parent не появляется в managed registry и не получает executor.
Такой parent передаётся в обычный `session.create.delegation`. Policy и immutable deadline
child ограничены host grant. Вложенный managed child наследует ту же root authority;
service create/retry/cancel и остальные lifecycle mutations требуют исходного issuer
и при managed direct parent. Managed mutation требует exact direct parent registration.

`delegation.application.renew` требует expectedExpiresAt и уникальный operationId;
приложение продлевает lease только пока исходный authenticated run активен.
`delegation.application.close` отзывает run при завершении/отмене. Renew не может
воскресить closed/expired authority или превысить hard deadline. Private bounded journal
хранит fingerprint и исходный receipt каждого update: изменённый повтор отказывает,
точный повтор не продлевает lease. Зарезервировано место для close после лимита renew.

Close, expiry или утрата binding прекращают новые input/wake/launch и resident execution
всех descendants через существующий owned lifecycle. Новая authority другого run не
оживляет прежний child; native history сохраняется. Application input принимается через
`message.send` с точным binding и исходными sourceMessageRef/authorizationQuote.
Managed input требует exact direct parent registration и ту же active root authority.
Steering и native answers для application children явно недоступны: их DTO не несут
нужную provenance; capabilities это отражают. Applied policy остаётся отдельным native
acknowledgement: lease/open/create receipt сам по себе не доказывает успешный model turn.

## Idle proof и sleep

`session.idle` (`async idleProof`) возвращает revision, runtime generation, run state, queue,
approvals, children, background и process identities. Источники — fresh native snapshot или живая
tmux-панель TUI, durable message ledger/cursors/input, registry lineage, context operations,
состояние `readWaiting` и дерево процессов. Будущие `notBefore`-письма не блокируют сон
(учитываются только due-сообщения `isDue(msg, now)` и активные `pickups`). Missing/stale facts,
approvals, активный turn, черновик, открытые меню, дети и необъявленные фоновые процессы отказывают.

Поддержка process release охватывает интерактивные TUI- и native-сессии `claude` и `codex`
(делегированные и неделегированные; для неделегированных native-сессий `registerRuntimeOwnership`
регистрируется при наличии `registrationGeneration`, а для `codex` дополнительно проверяются
`inspectNativeCodexInput` и `clientTypingRecently`). Провайдеры `opencode`, `custom` и
`antigravity` сохраняют `capabilities.sleep: false` и возвращают `release: unsupported,
state: unchanged`. `handles-only` — отдельное значение wire contract; адаптеры никогда не выдают
его за `processReleased`.

Для интерактивных TUI-сессий (`claude`, `codex`) `idleProof` проверяет ровно одну панель в
tmux-сессии (отказ `auxiliary-panes` при открытых дополнительных окнах), `inspectChatPane ===
'deliverable'`, `readTurnState.settled === true`, `resolveLiveState === 'idle'`, отсутствие
`readWaiting`, 60-секундное окно `clientTypingRecently`, отсутствие индикатора фоновых задач в
футере Claude и fail-closed классификацию дерева процессов (`classifyTuiProcessTree`). Допускаются
только `panePid`, ровно один прямой дочерний процесс провайдера, объявленные stdio MCP-серверы
сессии (`loadDeclaredMcpSpecs` — `command` и `args` без секретов, включая launcher-индирекцию
`bunx`/`npx`/`pnpx`/`uvx`) и `caffeinate` (macOS). Любые шеллы, `pgid`-сироты и необъявленные
процессы отказывают с `background-processes`.

`session.sleep` принимает exact target/registration, `operationId`, `revision` и опциональный
`forcePolicy`. Иерархия локов: `profile-policy.lock` → `admission.lock` (per-session) →
`registry.lock`. Для legacy TUI-сессий идемпотентный backfill `registrationGeneration` выполняется
в `healOnce` и `sleepSessionByName` (не затрагивает `LaunchStamp`; `LifecycleBlock` без
`generation` симметрично матчится по `uuid`); `sleepSessionByName` предварительно делает
`followFork`, а прямой `session.sleep` отказывает `REVISION_CONFLICT`, если диалог Claude форкнулся
до перечитывания `uuid` (в `healOnce` сам `followFork` берёт `withNativeAdmission` и не обгоняет
`sleepSession`). Политика профиля (`evaluateSleepPolicy`) запрещает сон для `pinned: true`
(`PINNED_SESSION`), нечитаемого или не-файлового `envFile` (`PROFILE_UNAVAILABLE`, в том числе при
`minAwakePerProfile: 0`) и при падении числа здоровых живых сессий того же профиля ниже
`idleSleep.minAwakePerProfile` (`MIN_AWAKE_PER_PROFILE`). Канонический ключ `sessionProfileKey`
различает дефолтный профиль Claude (`default`) и явный `CLAUDE_CONFIG_DIR`, изолирует
`ownCredentials` в отдельный ключ `custom-auth` по хэшу и нормализует `CODEX_HOME` по `realpath`.
Делегированные сессии не ограничиваются `minAwakePerProfile` и не засчитываются в его квоту.
Флаг `--force` (`forcePolicy: true`) обходит только политику (`pinned`/`minAwakePerProfile`),
не отменяя проверки `idleProof`.

После записи `phase: requested` native owner закрывает свои handles/provider, а для TUI
отправляется `SIGTERM` процессу агента (`_run` повторно проверяет `sleepBlocksStart` перед
`Bun.spawn` и сразу после завершения агента до `FAST_FAIL_MS` и `backoff`), при необходимости
вызывается `killSession` и сигналинг подтверждённых `(pid, startTime)`, затем `clearStatus` и
`forgetAgentPane`. Receipt `processReleased` выдаётся после асинхронного подтверждения ухода всех
`(pid, startTime)`. Heal, supervisor и `restart --all` не запускают sleeping-сессии. Чтение
`sleep.json` в общих циклах демона изолировано через `readSleepSafe` (один повреждённый файл не
роняет остальные сессии), а строгое `readSleep` на всех путях мутаций (`session.sleep`,
`session.wake`, `wakeSessionByName`) отказывает fail-first.

Опциональный авто-сон (`machine.json.idleSleep`, по умолчанию `enabled: false`) запускается в
цикле демона раз в `checkIntervalSeconds`, берёт якорь `computeIdleAnchorMs` (максимум из
`lastActivityMs`, `transcriptMtimeMs`, `startedAtMs`, `awakeAtMs`, `paneWorkingMs`, `lifecycleTs`,
`clientActivityMs`; fail-closed при всех `null`) и усыпляет кандидатов от самых старых к свежим с
пересчётом `minAwakePerProfile` после каждой сессии.

## Wake и idempotency

`session.wake`, `ccmux wake`, `ccmux start`, `ccmux attach`, Enter в TUI и due-письмо в
`deliverPending` пробуждают прежний registered/native context с тем же `uuid`. Wake ждёт release
вне admission lock: native resume использует этот же lock для selection. Фазы
`requested → sleeping → waking → awake` durable; `reconcileSleepRecord` при старте и в цикле
`healOnce` переводит `requested` с уже ушедшими процессами в `sleeping` (с очисткой `clearStatus`/
`forgetAgentPane`), откатывает устаревший (`> 30 с`) TUI `requested` с живой панелью обратно в
`awake`, а устаревший `waking` без tmux — обратно в `sleeping`. Доказательство пробуждения
проверяет свежую пару `(pid, startTime)` (защита от PID reuse), а для TUI — живого дочернего
провайдера и отрисованный экран (`scan.ready || scan.atPrompt !== null` по тексту со снятым ANSI)
с откатом `waking → sleeping` и fail-fast при `LifecycleBlock` или падении tmux.

Журнал `wake-operations.json` ограничен 256 записями и при заполнении вытесняет сначала
незавершённые (`result: null`) записи прошлых циклов сна, а затем старейшие завершённые записи
прошлых циклов (FIFO), предотвращая постоянный `WAKE_CAPACITY`. Старый completed wake возвращает
свой receipt, pending wake не будит следующий sleep.

В `deliverPending` спящие сессии проверяются чистым `pickPendingDelivery` без мутации курсоров:
будущие `notBefore`, `acked`, `archived`, `chatEnabled: false`, `blocked`, `delegationStopped`,
rate-limit и неподдерживаемые провайдеры не вызывают пробуждения. Активный wake координируется
single-flight с экспоненциальным backoff и честным `writeChatHold`. Для спящих TUI-сессий
`message.send` принимает письмо в ledger без 409 `SESSION_SLEEPING`, чтобы его разбудил
`deliverPending` в срок. Wake использует один deadline от начала вызова (до 25 секунд внутри
endpoint с transport timeout 30 секунд); медленный cold start возвращает `WAKE_PENDING`. Cancel и
deadline отказывают последующему wake. Операции `session.idle`, `session.sleep`, `session.wake` и
`session.pin` доступны через HTTP, CLI, MCP и peer forwarding (`FORWARDED_OPERATIONS`).

## Публикуемые bytes

Release содержит typed control-service-client и `ccmux-X.Y.Z.tgz` — детерминированный
`git archive` точного release commit с native source. CI загружает оба до публикации draft.
Source archive позволяет проверить включение реализации вместе с public contract.

## Creation and inference

`session.create` accepts `initialization: "allow-inference" | "no-inference"`.
Omission permits the established initialization behavior. `runtime.list` publishes each mode's
`capabilities.creation`: `noInference`, `inference`, and a stable `reason`.
A caller requiring zero model requests must explicitly request `no-inference`; a false capability
produces HTTP409 `NO_INFERENCE_CREATE_UNSUPPORTED` before workspace/config/model discovery,
receipt reservation or provider startup. Retrying an older completed request with this requirement
also refuses; an earlier model effect is never relabelled as inference-free. This refusal creates
no executor, native identity, pending registration or resumable context.

Claude native offers `noInference: true`, `inference: "deferred"`, reason
`delegated-input-only`, and requirements `delegation` / `explicit-model`. Its immutable read-only
delegation disables inherited hooks, plugins, MCP servers and agent creation. The provider starts
with an empty streaming input queue; no readiness prompt is submitted. The caller must supply
`modelSelection` with provider `claude` and a catalog key other than `default`. The actual runtime
catalog must verify that key before admission succeeds. Missing requirements return HTTP 409
`NO_INFERENCE_CREATE_REQUIREMENTS` before workspace or provider discovery.

The initialization requirement is persisted in the canonical receipt and session, including cold
restart. Ordinary create (omitted or `allow-inference`) has a different fingerprint from
`no-inference`: replaying one as the other returns `IDEMPOTENCY_CONFLICT`. A retry with the original
request keeps the exact registration, native conversation, delegation and model. An empty Claude
conversation can sleep before its first input and wake with the same pinned session ID; once input
persists native history, subsequent wakes resume that history. Input remains separately authorized
and can perform inference on the selected model. This guarantee concerns model requests, not all
provider metadata or account traffic.

Codex app-server reports `inference: "required"`, reason `native-rollout-requires-bootstrap`:
its current durable admission waits for rollout metadata produced by a readiness turn. Interactive
Claude, OpenCode and custom runtimes report `inference: "not-guaranteed"`, reason
`provider-initialization-not-certified`. These unsupported modes return HTTP 409
`NO_INFERENCE_CREATE_UNSUPPORTED` before workspace/config/model discovery, receipt reservation,
registration or provider startup. Capabilities describe the execution mode; host availability is
reported separately.

Delegation and application leases still guard ordinary create and input. No-inference refusal does
not authorize input, bypass policy, create a fake parent or change provider/account settings.
