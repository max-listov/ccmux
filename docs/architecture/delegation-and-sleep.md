---
title: Права делегированных executors и обратимый сон
description: Create-time authority, native policy evidence, idle CAS и продолжение той же identity.
type: architecture
status: active
created: 2026-10-15 08:00 +07:00
updated: 2026-10-15 09:59 +07:00
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

`session.idle` возвращает revision, runtime generation, run state, queue, approvals,
children, background и process identities. Источники — fresh native snapshot, durable
message ledger/cursors/input, registry lineage, context operations и ownership baseline,
который записал сам spawning owner до первого prompt. Future queued input тоже блокирует
sleep. Missing/stale facts, approvals, дети и дополнительные процессы отказывают.

Поддержка process release ограничена делегированными native Codex/Claude: их инструменты
и ownership ограничены до prompt. У остальных сессий `capabilities.sleep: false`;
idle proof объясняет unsupported/unbounded-native-background-state, sleep возвращает
`release: unsupported, state: unchanged`. Он не убивает чужой executor и не архивирует
сессию. `handles-only` — отдельное значение wire contract; эти native adapters никогда
не выдают его за processReleased.

`session.sleep` принимает exact target/registration, operationId и revision. Он сверяет
proof под тем же native admission lock, который принимает input, и атомарно пишет
requested. Owner сам закрывает свои handles/provider. Receipt processReleased выдаётся
только после исчезновения всех измеренных PID+startTime; timeout оставляет durable intent
для повтора. Heal и supervisor не запускают sleeping session. Повреждённый journal
отказывает; missing отличается внутри одного чтения, без exists-after-read race.

## Wake и idempotency

`session.wake` и новый `message.send` пробуждают прежний registered/native context.
Wake ждёт release вне admission lock: native resume использует этот же lock для selection.
Фазы requested → sleeping → waking → awake durable. Wake operation связан с конкретным
sleep operation и registration; проверки identity повторяются перед start и acknowledgement.
Старый completed wake возвращает свой receipt, pending wake не будит следующий sleep.

Новый input сначала проходит admission; sleeping target пробуждается вне lock, после чего
admission повторяется. Проверка sleep находится внутри lock после duplicate lookup:
повтор уже принятого сообщения не будит последующий sleep и не исполняет работу заново.
Регистрация, native history, request/message IDs и settled operation records сохраняются.
Wake использует один deadline от начала вызова, включая ожидание release: до 25 секунд
внутри endpoint с transport timeout 30 секунд. Медленный cold start возвращает WAKE_PENDING;
повтор продолжает тот же durable wake operation. Cancel/deadline отказывает последующему wake. Контракт доступен через HTTP, CLI и MCP,
схемы и typed service client строятся из одного control contract.

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
