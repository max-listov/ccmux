---
title: ccmux — видение
description: Persistent self-healing флот агентских сессий на всех машинах — от tmux-супервайзера к live-клиенту «агентский отдел в кармане»
type: vision
status: active
created: 2026-06-11
updated: 2026-08-30
---

# ccmux — куда идём

## Что это
Супервайзер **постоянных агентских сессий** и единый identity-pinned chat для поддерживаемых
interactive и structured runtimes (Claude Code, Codex CLI/App Server и OpenCode server).
Один демон на машину держит флот живых сессий в tmux: хилит упавшие, поднимает на ребуте,
резюмит ту же беседу по фиксированному managed ID и native continuation. Provider runtime может
быть интерактивным CLI или headless server: inference, tools и история остаются у него.
Remote Control/statusline и permission-mode — Claude-specific capabilities; Codex сохраняет
свой TUI/App Server, а OpenCode работает через authenticated API и SSE.

## Принципы
- **Супервизор, не agent loop** — native CLI/SDK/API выбирается по runtime. Подписка, API account,
  inference, tools и prompts принадлежат runtime/host configuration, не новому общему циклу CCMux.
  Capability discovery честно различает поддерживаемые операции, не обещая равенства всех адаптеров.
- **Один provider runtime = один writer** — managed Codex поддерживает обычный TUI и opt-in
  native App Server под существующим supervisor; у Claude аналогично есть opt-in native режим на
  опубликованном agent SDK рядом с интерактивным по умолчанию. Claude — первый случай, где инвариант
  может нарушиться по-настоящему: SDK пишет в тот же conversation store, что и интерактивный CLI,
  поэтому managed id и id беседы пиннятся в одно значение и оба исключаются из discovery/adoption. В App Server режиме терминальный CLI — клиент
  того же writer, статусы и управление идут по native protocol. Изоляция env сохраняется на
  уровне каждой сессии. Решение: [owned native runtime](decisions/2026-08-28-owned-native-codex-runtime.md). Для thread,
  уже принадлежащего Codex App, ccmux подключается клиентом к существующему shared App Server и
  отправляет provider-native `turn/start`; второй runtime и второй writer не создаются.
- **Runtime отдельно от model provider** — Claude, Codex и OpenCode имеют разные протоколы;
  выбор модели не создаёт новый вид сессии. Optional Custom использует только опубликованный
  Stitchkit harness; до квалификации managed adapter он явно unavailable, без скопированного цикла.
- **Native история — источник правды беседы**: JSONL у interactive CLI, structured API/events
  у headless server. Пейн-скрейп остаётся только в существующих interactive adapters.
- **Production-система**: рулит реальными сессиями на флоте машин. Деплой — только по
  явному «го» (см. CLAUDE.md), сессии переживают апдейты и ребуты.

## Траектория
Для периодического мониторинга демон публикует ограниченный status snapshot: чтение готового
наблюдения не запускает новый обход transcript и panes. Resident consumer использует native
reader без CLI-процесса на каждый poll, с ограниченными чтением, deadline и concurrency. Контракт — в
[monitoring-status](architecture/monitoring-status.md).

Resident control объединяет typed HTTP/CLI/tool API и bounded live snapshots на локальном Unix
socket. Stitchkit управляет контрактом, transport и lifecycle ресурсов daemon; CCMux сохраняет
session identity, журнал сообщений, provider adapters и restart policy. Контракт —
[control-plane](architecture/control-plane.md). Для authenticated declared-service transport CCMux
также публикует owner descriptor, fixed ingress и stable-cursor native stream profile поверх тех же
handlers/admission; локальный socket не проксируется наружу. Это не замена provider harness и не
подключение официального Desktop к чужому writer.

Managed create может выбрать immutable host-owned launch recipe безопасной ссылкой id+revision.
Recipe остаётся конфигурацией execution host и разворачивается в уже существующие `flags`,
`envFile`, session environment и launch stamp; caller не передаёт path, executable, shell или
secret. Та же immutable recipe может выбрать установленный Codex collaboration preset: provider
support проверяется до каждого turn, который начинает CCMux, а native input продолжает идти через один exact response
contract. Решения: [server-owned control launch recipes](decisions/2026-08-29-server-owned-control-launch-recipes.md)
и [managed collaboration policy](decisions/2026-08-29-managed-codex-collaboration-policy.md).

Native model catalog читается до создания первого thread. Typed `modelSelection` живёт отдельно
от host profile, сохраняется при retry/restart и не подменяется Plan-пресетом. Это управление
native Codex/GPT, не универсальный inference runtime. Workspace picker использует bounded
`directory.list`, а не shell-команду. Решение: [catalog and selection](decisions/2026-08-30-native-catalog-and-model-selection.md).

`runtime.list` сообщает установленные execution runtimes и их capabilities. `session.create`
выбирает runtime отдельно от `modelSelection`; omitted runtime сохраняет Codex. OpenCode использует
host-native provider catalog, отдельный `ses_…` continuation и тот же control/chat/wait plane.
Решение: [managed runtime drivers](decisions/2026-08-30-managed-runtime-drivers.md).

1. **Сейчас**: Bun-версия боевая локально (паритет с прежней реализацией подтверждён аудитом),
   раскатка на серверы — по команде владельца.
2. **Флот без рук**: CI + GitHub Releases → демоны сами подтягивают апдейты
   (auto-update уже в коде) — деплой на флот перестаёт быть ручным.
3. **Live-клиент** («агентский отдел в кармане»): WS-сервер поверх watch jsonl → живой
   транскрипт + управление флотом с телефона/браузера, событийно, без поллинга.
4. **Ниша**: «persistent multi-machine self-healing fleet» — свободна в экосистеме
   (ACP-ресёрч 2026-06-10); acpx и адаптеры — single-machine, без хилинга/флота.

## Что ccmux НЕ делает
Не IDE-клиент, не замена tmux, не прокси model API. Не копирует native Desktop task bus и не
объявляет чужие App threads daemon-healed managed sessions. Не заменяет provider harness,
inference transport или authentication собственной реализацией. Native App Server mode
сохраняет интерактивный CLI как клиент и не обещает подключения официального Desktop.

## Название

В текущем scope сохраняется CCMux: continuity существующих addresses, packages и deployments
важнее косметического переименования. «Agent session supervisor» описывает роль точнее, чем
«Claude multiplexer»; «runtime control plane» описывает публичный API, но не отдельный продукт.
Возможный будущий rename требует отдельного migration decision и не меняет пути/бинарники сейчас.
