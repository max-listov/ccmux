---
title: Права делегированных executors и обратимый сон
description: Create-time authority, native policy evidence, idle CAS и продолжение той же identity.
type: architecture
status: active
created: 2026-10-15 08:00 +07:00
updated: 2026-10-15 08:37 +07:00
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
повторяет sandboxPolicy при каждом turn/start. Делегированный Codex работает headless.
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
