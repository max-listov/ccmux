---
title: Оценить Codex App Server как structured driver
description: Проверить, может ли app-server убрать pane scraping без потери интерактивного TUI и subscription flow
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 11:43 +07:00
---

## Зачем

Современный Codex App Server предоставляет structured thread inventory, source filters, runtime
status, loaded-thread list, read/resume/fork, streamed turn events и remote TUI connection. ccmux
пока управляет Codex как обычным процессом: читает JSONL, скрейпит pane и вводит текст через tmux.
Для Codex это оставляет некалиброванные readiness и menu-safety границы.

При этом Desktop-only task tools не являются автоматически доступными обычному CLI thread, а live
thread защищён active-writer lock. Нельзя молча считать, что переход на app-server сам даст CLI
межзадачный chat или позволит Desktop и ccmux одновременно владеть одной беседой. Нужен живой
протокольный spike до выбора архитектуры.

## Результат

- Есть воспроизводимый conservative decision probe для version-matched stdio protocol: состояние
  до первого turn, process-local `notLoaded`, cross-process writer conflict и resume того же UUID
  после завершения владельца.
- Remote TUI parity/approval/reconnect matrix честно не принимается за production evidence: внешний
  command/remote flow experimental, WebSocket production-unsupported, поэтому runtime cutover
  отвергнут до указанного в ADR условия пересмотра.
- Отдельно установлено, какие tools принадлежат стандартному app-server, а какие внедряются только
  Desktop host и не могут считаться частью CLI provider.
- Принято и записано одно решение: оставить процессный TUI provider, перейти на app-server-backed
  provider либо использовать hybrid; перечислены последствия для self-heal, chat и ownership.
- До решения ccmux не строит неофициальный мост к внутреннему Desktop process и не конкурирует за
  writer существующего thread. Глубокие remote/topology probes не выполняются после decisive
  production gate: они не могут изменить решение текущей версии.

## План

- [x] Зафиксировать официально поддержанные App Server transports, thread lifecycle, source kinds,
  runtime states, approvals и remote TUI contract для текущей стабильной версии Codex; отдельно
  отметить, что обычный Codex TUI уже использует in-process App Server client. Сгенерировать
  version-matched stable/experimental schemas и разделить maturity команды, transport и методов.
- [x] Собрать минимальный локальный protocol spike через публичный App Server interface — выполнен
  decisive stdio path: pre-turn persistence, successful streamed turn, process-local list status,
  competing App Server resume conflict, graceful owner exit и same-UUID resume.
- [x] Проверить `codex --remote` как пользовательский TUI: отклонено после production gate — config, slash commands, approvals,
  subscription flow, ccmux flags/root guard/env/management prompt и восстановление после разрыва
  клиента, pending approval, рестарта supervisor и App Server. Доказать per-thread `CCMUX_SESSION`
  и остальные session-specific env либо отвергнуть shared topology.
- [x] Сравнить топологии `один App Server на машину`, `один на managed session` и `sidecar внутри
  tmux` — архитектурно отвергнуты: shared ломает isolation/per-thread env, per-session добавляет
  unsupported failure domain, hybrid создаёт второго mutation-capable owner.
- [x] Проверить structured delivery: вынесено из текущего runtime решения — App Server не выбран как
  transport, поэтому chat обязан доказать безопасность на process TUI detector.
- [x] Разделить probes по transport: stdio проверен; unix/remote TUI и loopback WebSocket отклонены
  как не меняющие решение после experimental/production gate. Default Desktop socket не тронут.
- [x] Проверить reconnect без выдуманного event replay: подтверждён только persisted same-UUID
  resume после owner exit; undocumented event replay не заявлен.
- [x] Сопоставить три варианта driver: process TUI, app-server-backed и hybrid — против инвариантов
  ccmux по persistence, self-heal, ownership, chat safety и публичным API.
- [x] Записать решение в `docs/decisions/` и обновить зависимые architecture docs без реализации
  выбранного driver в рамках этой исследовательской задачи; отдельно назначить source of truth для
  thread id, transcript, runtime state и writer ownership.

## Acceptance

- [x] Все утверждения опираются на официальный contract либо воспроизводимый локальный probe с
  указанной версией Codex; предположения явно отделены от фактов.
- [x] Решение не использует внутренний Desktop socket/process и не предполагает наличие
  Desktop-injected tools в обычном CLI/App Server thread.
- [x] Явно определено, что authoritative admission — atomic resume самим managed process;
  discovery-state advisory и не разрешает takeover.
- [x] `thread/loaded/list` и runtime status не принимаются за глобальный writer registry без
  cross-process доказательства; kill/reconnect matrix не создаёт второго writer.
- [x] `sourceKinds` трактуется только как origin metadata: дефолтный `thread/list` видит лишь
  interactive sources, source не равен ownership и не заменяет ccmux session identity.
- [x] Tools классифицированы как built-in App Server, config-backed MCP/plugin, experimental
  client-supplied dynamic tools или Desktop-host injected; `thread/inject_items` не называется
  межсессионным wakeup/chat.
- [x] Approval matrix: отклонена для текущего runtime cutover после decisive production gate; ADR
  не делает утверждений о parity и требует эту матрицу перед будущим пересмотром.
- [x] Production runtime разрешён только на стабильном публичном contract. Допустимый итог —
  сохранить process TUI provider, если remote transport/TUI parity остаются experimental или не
  доказаны.
- [x] Для каждого ccmux-инварианта указан источник доказательства: официальный contract, source
  текущей версии или локальный probe.
- [x] Protocol fixtures и логи санитизированы: нет реальных cwd, host/session names, thread ids,
  titles и пользовательских prompts.
- [x] Выбран ровно один основной driver boundary; отвергнутые варианты и цена будущего пересмотра
  перечислены.
- [x] Два read-only валидатора проверили план, затем два — фактическое решение; все блокирующие
  находки исправлены и повторный probe прошёл.

## Конвейер 2/2

- [x] Валидатор плана 1: официальный contract и границы supported API — уточнены maturity,
  process-local statuses, schemas, reconnect и tool origins.
- [x] Валидатор плана 2: ccmux invariants, ownership и операционные риски — добавлены topology,
  kill matrix, source-of-truth, per-thread env, ресурсы и sanitization.
- [x] Валидатор реализации 1: подтвердил воспроизводимость probe; добавлены exact turn/status
  assertions и bounded fail-safe cleanup.
- [x] Валидатор реализации 2: подтвердил согласованность ADR; уточнены atomic ownership,
  same-cwd identity race и provider-specific capabilities.

## Правки валидатора-1

- Установленная версия фиксируется отдельно от maturity: `codex-cli 0.147.0`; команды
  `app-server`/`--remote` помечены experimental, а WebSocket transport отдельно объявлен
  production-unsupported.
- Writer ownership проверяется conflict matrix, а не `thread.status`/`thread/loaded/list`.
- Reconnect не предполагает undocumented event replay; standalone App Server tools отделяются от
  Desktop-host injected tools.

## Правки валидатора-2

- Сравниваются три process topology и их failure domain, self-heal owner, ресурсы и single-writer
  guarantee.
- Зафиксированы четыре независимых source of truth: thread id, transcript, runtime state и writer
  ownership.
- Remote parity включает текущие ccmux flags/root guard, management prompt и per-thread env, а
  fixtures обязаны быть публично безопасными.

## Что сделано

- [x] Decision: выбран process TUI driver и записаны ownership/revisit boundaries в
  `docs/decisions/2026-08-10-codex-process-tui-driver.md`.
- [x] Probe: добавлен изолированный version-matched stdio сценарий в
  `scripts/codex-app-server-probe.ts`; подтверждены pre-turn rejection, exact `PROBE_OK`,
  process-local `notLoaded`, writer conflict и same-UUID resume.
- [x] Reliability: cleanup probe ограничен таймаутами с `SIGTERM` → `SIGKILL`, все clients
  завершаются независимо, временный state удаляется в отдельном `finally`.
- [x] Vision: provider-neutral принципы и provider-specific capabilities уточнены в
  `docs/VISION.md`.
- [x] Что не делалось: runtime driver не менялся; remote TUI/unix/WebSocket parity matrix вынесена
  за decisive production gate, релиз и fleet update не выполнялись.
