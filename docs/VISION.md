---
title: ccmux — видение
description: Persistent self-healing флот агентских сессий на всех машинах — от tmux-супервайзера к live-клиенту «агентский отдел в кармане»
type: vision
status: active
created: 2026-06-11
updated: 2026-08-29
---

# ccmux — куда идём

## Что это
Супервайзер **постоянных агентских сессий** и единый identity-pinned chat для поддерживаемых
interactive runtimes (Claude Code, Codex CLI и Codex App Server threads).
Один демон на машину держит флот живых сессий в tmux: хилит упавшие, поднимает на ребуте,
резюмит ту же беседу по фикс-uuid. Сессии — полноценные интерактивные provider CLI на подписке
пользователя, не headless-обвязка. Remote Control/statusline и permission-mode — Claude-specific
capabilities; Codex сохраняет свой TUI/config/approvals и provider-specific resume.

## Принципы
- **Интерактивный CLI, не SDK** — сессии остаются на подписке пользователя и сохраняют
  provider-specific capabilities: Claude — RC/statusline, Codex — TUI/config/approvals/resume.
  Мы супервайзим, а не реимплементируем.
- **Один provider runtime = один writer** — managed Codex поддерживает обычный TUI и opt-in
  native App Server под существующим supervisor. В App Server режиме терминальный CLI — клиент
  того же writer, статусы и управление идут по native protocol. Изоляция env сохраняется на
  уровне каждой сессии. Решение: [owned native runtime](decisions/2026-08-28-owned-native-codex-runtime.md). Для thread,
  уже принадлежащего Codex App, ccmux подключается клиентом к существующему shared App Server и
  отправляет provider-native `turn/start`; второй runtime и второй writer не создаются.
- **Агент-агностичность** — провайдер на агента (`src/agent/<id>/`), ядро говорит только
  с контрактом. Claude сегодня, Codex и ACP-агенты — когда дозреют.
- **jsonl — источник правды беседы**: транскрипт, токены, «где остановилось» читаются из
  истории агента, не скрейпом. Пейн-скрейп — только для live-статуса.
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
