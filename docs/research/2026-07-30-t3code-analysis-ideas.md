---
title: t3code (pingdotgg/t3code) — разбор и идеи для ccmux
description: Глубокий анализ T3 Code (agent-harness control surface для Claude/Codex/Cursor/Grok/OpenCode) — что перенять для ccmux, фокус на сессиях и персисте
type: research
status: active
created: 2026-07-30
updated: 2026-07-30
---

# t3code → ccmux: разбор и 22 идеи

Источник: `github.com/pingdotgg/t3code` (клон `~/home/deps/t3code`, ~15k файлов).
Анализ: 5 параллельных read-only агентов по подсистемам (Codex-драйв · ACP-абстракция ·
сервер+персист · remote/транспорт · build/agent-config) + собственное чтение docs/архитектуры.

## Что такое T3 Code
«Agent harness control surface» — рулит агентами (Claude Code, Codex, Cursor, Grok, OpenCode)
с web/desktop(Electron)/mobile(RN). `npx t3@latest` поднимает Node-WS-сервер + web-app. Стек:
pnpm-catalog монорепо, **effect-ts**, vite-plus (`vp`), кастомный oxlint-plugin, Rust
`native/resource-monitor`. Прямой сосед ccmux по нише, но GUI-first и крупнее.

## ГЛАВНЫЙ тезис (архитектурный водораздел)
**T3 НЕ скрейпит pty и НЕ парсит jsonl-файлы. Он говорит с агентами по программным протоколам**
и переводит их нативные события в одну каноническую event-модель:
- **Codex** → `codex app-server` (JSON-RPC 2.0 over stdio, line-delimited).
- **Claude** → `@anthropic-ai/claude-agent-sdk` `query()` (живой async-iterable `SDKMessage`).
- **Cursor/Grok/OpenCode** → **ACP** (Agent Client Protocol v0.11.3 — протокол Zed, JSON-RPC/stdio).

Персист — **не** «держать процесс живым», а **append-only sequenced event-log в SQLite** (CQRS) +
per-session resume-курсор; idle-агентов **reap'ят** и ре-резюмят по требованию. Это философски
**обратно** ccmux (tmux держит всех вечно). Оба подхода валидны — см. идею #10 (гибрид).

---

# Идеи (ранжировано по рычагу; фокус — сессии/персист)

## A. Как говорим с агентом (ядро — сессии)

### 1. ⭐ Структурированный control-channel вместо pty-скрейпа — ТЕЗИС
Всё, что ccmux реконструирует скрейпом (модель, working/idle, context%, tool-calls), у T3 приходит
типизированными событиями протокола. Codex: `codex app-server` (реф-драйвер ~60 строк:
`packages/effect-codex-app-server/test/examples/codex-app-server-probe.ts`; транспорт
`.../src/protocol.ts`). Claude: SDK `query()` → `interrupt()/setModel()/getContextUsage()`
(`apps/server/src/provider/Layers/ClaudeAdapter.ts:1366`). Убирает ВЕСЬ класс эвристик «спиннер
остановился? / это меню? / докрутился?». **Переносим протокол, НЕ effect-ts стиль** — реюзабельное
ядро ~250 строк: line-buffered stdio JSON-RPC + `id→Promise` pending-map + две очереди (нотификации
vs server→client запросы) + реестр хендлеров. `Bun.spawn` + async-iter `proc.stdout` покрывает нативно.

### 2. ⭐ Two-id модель + resume-fallback — убивает нашу codex-reconcile боль
T3 держит СВОЙ стабильный `threadId` + codex-id в `resumeCursor` (из ответа `thread/start` и
рефрешится из нотификации `thread/started`). Resume: `thread/resume`, при ошибке «not found» —
**прозрачный fallback на `thread/start`** (`CodexSessionRuntime.ts:436-493`). Нам не надо сканить
`~/.codex/sessions` за новейшим jsonl — id отдаёт протокол и он self-heal'ится. (Мы только что
сделали reconcile через detectFork — это его протокольная замена, чище.)

### 3. ⭐ Авторитетные working/idle + токены из turn-событий
`turn/started`→running+`activeTurnId`; `turn/completed`→ready/error + `error.message`;
`thread/tokenUsage/updated`→точные токены; `error{willRetry}`→transient vs реальный сбой
(`CodexSessionRuntime.ts:917-965`). Это ровно то, что ccmux сейчас угадывает по тексту пейна —
получаем как факт, включая «сессия упала с ошибкой X» (по пейну недостижимо).

### 4. История через `thread/read {includeTurns:true}`, не парсинг jsonl
Полная история — один RPC с типизированными item'ами; `thread/list` перечисляет сессии;
`thread/rollback` обрезает. Не зависим от on-disk формата (он меняется между версиями), нет
partial-write гонок, одна схема и live и on-demand.

### 5. Структурированные approvals как отвечаемые запросы — auto-mode «правильно»
Codex шлёт `item/commandExecution/requestApproval` / `fileChange/requestApproval` /
`tool/requestUserInput` как server→client **запросы**; отвечаешь типизированным решением
(`CodexSessionRuntime.ts:967-1129`). Наш auto-классификатор мог бы смотреть РЕАЛЬНЫЙ
command/patch-пейлоад и отвечать `approved/denied`, а не матчить нарисованный промпт и слать
keystrokes. Плюс sandbox/approval-policy задаётся декларативно на `thread/start` — часть аппрувов
исчезает политикой.

### 6. Типизированная инъекция промпта + interrupt/steer
`turn/start` со структурным `input` (текст+картинки), model/effort инлайн; `turn/interrupt`,
`turn/steer` — детерминированные RPC вместо `send-keys` (с его `=NAME:0.0` и префикс-коллизиями).
Работает одинаково headless.

### 7. Богатый resume-курсор
`{threadId, resume:<uuid>, resumeSessionAt:<last-assistant-uuid>, turnCount}`
(`ClaudeAdapter.ts:1449-1467`) вместо нашего «новейший jsonl uuid». Устойчивее к ротации/рестарту.

### 8. Replay-idle gate на resume — нет двойной эмиссии
На `session/load` агент переигрывает историю; T3 глушит её, пока не наступит 2с idle-gap без
replay-активности (`AcpSessionRuntime.ts:370-404,590-632`). Ровно наша проблема «resume по uuid
переизлучает историю как live».

## B. Персист и модель сессий

### 9. ⭐ Append-only sequenced event-log в SQLite = источник правды (CQRS)
`orchestration_events` (global `sequence`, `stream_id`, `stream_version` optimistic-concurrency,
`event_id` idempotency — `persistence/Migrations/001_OrchestrationEvents.ts`). Клиентские вью —
проекции, перестраиваемые из событий. **Это фундамент** под live-клиент: курсор-реконнект,
мульти-клиент, replay — всё выводится отсюда. У нас источник = jsonl агента (ок для 1 зрителя, но
нет монотонного курсора и «событий после X»). Per-machine SQLite-лог (sequence, session, type,
payload) — предпосылка live-web.

### 10. ⭐ Reap idle + resume-on-demand — гибрид с tmux
T3: reaper сметает сессии idle >30мин (skip если активный turn), процесс отпускается, ре-резюм по
курсору на след. сообщении (`ProviderSessionReaper.ts` + `ProviderCommandReactor.ts:572-596`).
ccmux УЖЕ умеет resume по фикс-uuid → возможен **гибрид**: truly-idle сессии suspend'им (освобождаем
RAM/контекст claude-процессов), tmux-пейн держим, на входящее — ре-launch. Наш «tmux переживает
ребут + attach по SSH» при этом СИЛЬНЕЕ их модели — не отдаём, а дополняем.

### 11. Одна каноническая event-union + `raw`-тег источника
`ProviderRuntimeEvent` (~48 типов, `packages/contracts/src/providerRuntime.ts`) + канонические enum
(`CanonicalItemType`/`CanonicalRequestType`/`RuntimeContentStreamKind`), каждое событие несёт `raw`
с оригиналом (`"claude.sdk.message"`/`"codex.app-server.notification"`/`"acp.jsonrpc"`). Наш
per-provider normalize → ОДНА схема, которую читают TUI/статус/чат; новый провайдер лишь эмитит union.

### 12. Two-strategy adapter-фасад + `capabilities`-запись
`ProviderAdapterShape` (`Services/ProviderAdapter.ts:45-126`): `startSession/sendTurn/interruptTurn/
respondToRequest/streamEvents` + `capabilities` (напр. `sessionModelSwitch: in-session|unsupported`).
Native-SDK и ACP-агенты реализуют ОДИН интерфейс. Расширить наш provider-interface до этой формы →
новый ACP-агент = ~10 строк spawn-конфига (`acp/CursorAcpSupport.ts:39-62`), не новый скрейпер.

### 13. Мультиплекс-safety: штамп/валидация `providerInstanceId`
`ProviderService` мёржит стримы всех адаптеров, штампуя instance-id и отбивая утечку событий между
инстансами (`Layers/ProviderService.ts:191-199`). Полезный guard для нашего мульти-сессийного демона.

## C. Live web/mobile клиент (наш inbox-таск)

### 14. Contract-first типизированный RPC поверх одного WS; `stream:true` = одно поле
`Rpc.make(name,{payload,success,error,stream?})` в одном `RpcGroup` — стриминг-подписка это просто
RPC с флагом (`packages/contracts/src/rpc.ts`). Клиент получает типизированный API: unary→Promise,
stream→Stream, один сокет, ноль ручных envelope. Нам: shared-схема `ccmux/contract` (list/new/rm/
restart/mode/send/msg как unary + subscribeFleet/subscribeTranscript как stream). Мы Zod-native —
переносим ИДЕЮ (стрим = флаг схемы), не обязательно @effect/rpc.

### 15. ⭐ snapshot + `afterSequence`-курсор + `synchronized`-маркер + bounded-gap fallback
Каждый аггрегат несёт `snapshotSequence`, событие — `sequence`; стрим шлёт union
`snapshot|event|synchronized`; реконнект передаёт last-sequence → сервер реплеит ТОЛЬКО пропущенное,
а если отстал >1000 — свежий снапшот (`ws.ts:1104-1210`). Наш `transcript --json --cursor LINE`
УЖЕ это приближает — достроить fleet-стрим (лёгкий: name/dir/model/state/uptime/phase) отдельно от
тяжёлого transcript-стрима.

### 16. ⭐ Подписка на live ДО загрузки снапшота (буфер в scope-queue)
Форкнуть live-очередь ПЕРЕД чтением снапшота, дедуп по sequence на клиенте (`ws.ts:1113-1128`).
Убирает гонку потери события, стрельнувшего между «читаю состояние» и «подписываюсь». Самый частый
баг любого live-sync — сделать правильно с первого раза.

### 17. Снапшот через HTTP-gzip, WS только для дельт
Начальный (много-KB) снапшот отдаётся `GET`-ом (gzip транспортом), сокет — только live-хвост, resume
с sequence снапшота; таймаут 6с + fallback на socket-снапшот (`state/threadSnapshotHttp.ts`). На
phone-линке — крупнейшая экономия байт.

### 18. Connection-supervisor как явная стейт-машина
Фазы `available|offline|connecting|backoff|connected|blocked`; экспоненциальный backoff
`[1,2,4,8,16]s`, сбрасывается ТОЛЬКО после ≥30с стабильности; **transient vs blocked** (blocked =
auth/permission → ждёт сигнала, не спиннит вечно); wake-сигналы `application-active` (телефон
разблокировали → дешёвый probe мёртвого сокета) + `credentials-changed`; авто-resubscribe через
`switchMap` над session-ref (`packages/client-runtime/src/connection/supervisor.ts`). Портировать
целиком под мобайл-робастность.

### 19. Scoped-токены + live Devices-реестр + two-tier pairing
Токены `read` vs `operate` vs `terminal:operate` (`auth.ts`) — телефону по умолчанию read-only
watch, для ввода/`mode` нужен operate. `subscribeAuthAccess` стримит подключённые устройства
(тип/OS/IP/lastConnected) с revoke — «Devices»-экран без polling. Pairing: one-time код (алфавит
без 0/O/1/I) → HMAC-подписанный токен (DB-строка только для revoke), токен в URL-фрагменте (не в
логах), QR в терминале, + эфемерные 5-мин WS-токены. Ложится на наш permission-mode ethos.

## D. Remote-доступ

### 20. ⭐⭐ SSH-туннель без инфры — НАИВЫСШИЙ рычаг (у нас SSH-субстрат УЖЕ есть)
Клиент SSH-ится в бокс, скриптом поднимает loopback-bound сервер (`--host 127.0.0.1`), реюзает
живой если healthy, авто-ставит CLI через `npx` если нет, минтит one-time pairing-токен и читает его
из stdout SSH-канала; дальше `ssh -L` + bearer-токен (`packages/ssh/src/tunnel.ts`). **SSH = и
транспорт, и bootstrap доверия** — ноль публичных портов/облака. Наша hub-and-spoke SSH-модель уже
отвечает на «можешь ли ты сюда» → это самый дешёвый путь к «рулю флотом с ноута/телефона».

### 21. Tailscale serve / outbound-туннель / connection-target union
`tailscale serve --bg --https=443 http://127.0.0.1:<port>` → бокс на tailnet по HTTPS с MagicDNS,
без Cloudflare-аккаунта/сертов (`packages/tailscale`). Либо outbound cloudflared-туннель (без
входящих портов, `cloud/ManagedEndpointRuntime.ts`). Всё за одним `connection-target` union
(`Loopback|Ssh|Tailscale|Relay`) с per-kind брокером → supervisor/reducer транспорт-агностичны.
Гигиена: **никогда не логировать сырой stderr ssh/tailscale** (там `tskey-…`/хосты) — классифицировать
в закрытый enum (важно под наш public-repo/приват-правила).

### 22. «Агент поднял руку» → пуш на телефон
Окружения публикуют компактный per-thread activity (`running|waiting_for_approval|
waiting_for_input|completed|failed` + headline + deep-link), relay фанит в iOS Live Activity/push,
есть агрегат «N агентов активно» (`packages/contracts/src/relay.ts`), per-device тумблеры
(onApproval/onInput/onCompletion/onFailure), подписанные JWT с nonce. У нас сессии УЖЕ имеют фазы —
крошечный publish (даже в наш `tool tg_send`, не полный APNs-relay) превращает ccmux из «я смотрю»
в «оно пингует, когда сессия ждёт ввод», с deep-link в транскрипт.

## E. Meta / DX / build (воркфлоу мейнтейнера)

### 23. ⭐ resource-monitor сайдкар (у ccmux монитора НЕТ, а TUI жёг ядро 14ч)
`native/resource-monitor` (Rust, `sysinfo`): версионированный **NDJSON stdio-протокол**
(`PROTOCOL_VERSION`, команды `Configure/SetExternalProcesses/SetStreaming/SampleNow/ReadHistory`,
события `hello/snapshot/historyChunk`). Трекает дерево rootPid **+ внешние PID** (= ровно наша
топология: демон=root, каждый claude/codex-пейн=внешний PID). Решил неочевидное:
**PID-reuse guard** (валидация по `start_time`, отбой потомков старше родителя), **bounded history
ring** (1ч/3600/20k/64MB), **streaming-toggle** (запись всегда, push только по запросу — ровно твоя
«шли закон, не поток кадров»). Per-process cpu%/cpu_time/rss/io/status. Сайдкар (Rust или Bun-ребёнок)
с этим протоколом даёт per-session CPU/mem + история для `list`/TUI.

### 24. ⭐ release-smoke (tmpdir dry-run) + mock-update-server
`scripts/release-smoke.ts` гоняет ВЕСЬ релиз-пайплайн в `mktemp` без публикации и **проверяет
инварианты** (версия поднялась, оба arch-ассета в манифесте, per-arch входные почищены), потом
`rm -rf`. `scripts/mock-update-server.ts` отдаёт фейковые Releases на localhost (с path-traversal
guard) → тест fetch/apply self-update офлайн. **Прямо бьёт по нашим свежим self-update багам** (0.1.18
«stale/older бандл не должен даунгрейдить», 0.2.0 ENOENT): assert «new>current, hash совпал, нет
downgrade» на этапе билда, а не на флоте.

### 25. Кастомные oxlint-правила = перф/арх-инварианты как build-ошибки
`oxlint-plugin-t3code`: `no-inline-schema-compile` (hot-path перф в lint), `no-global-process-runtime`
(один seam для host-detect). Наши TUI-инварианты из `CLAUDE.md` («спиннер тикает только при active»,
«ChatMessage/Markdown мемоизированы», «нет непрерывных reflow-анимаций») гниют в прозе — 1-2 из них
как oxlint-правило (~50-150 строк) превращают «комп горячий»-инциденты в build-fail.

### 26. `CLAUDE.md → AGENTS.md` симлинк + промоут шрамов в repo-правила
Один канон-файл, симлинк — ноль дрейфа между Claude/Codex/Cursor. Наш глобальный chezmoi — для
`~/.claude`, а per-repo аналога нет: симлинк его даёт. Плюс промоутнуть в repo-инструкции наши шрамы
(`pkill -f` ловит свой процесс; не трогать живой реестр read-write; no-sleep тесты) — каждая
агент-сессия наследует.

### 27. Version-pinned `.repos/` subtree vs ad-hoc `~/home/deps`
`scripts/sync-reference-repos.ts`: читает версию зависимости из своего манифеста → git-тег →
`git subtree add|pull --squash` в `.repos/<id>`. Закоммичено, read-only, ТОЧНО той версии, что
зависимость. Сильнее нашего `~/home/deps` (per-machine, unpinned, невидим агенту в worktree/др.
машине). Вендорить 1-2 либы/доки, которые агенты чаще читают.

### 28. `.macroscope`-стиль AI-ревьюер как файл
Ревью-агент = markdown+frontmatter (`model/effort/input/tools/include` + `conclusion:failure` по
умолчанию + прозовый ruleset). Наши repo-правила («не светить приватные идентификаторы», «не
деплоить без аппрува») — идеальный кандидат: per-PR ревьюер, сканящий дифф на приватные токены/хосты/
абсолютные home-пути. Хвост «ответь ровно `All clear` и остановись» — хороший токен-дисциплина паттерн.

---

# Топ-5 по рычагу для ccmux (рекомендация с чего начинать)
1. **#1/#3/#4/#6 — Codex через app-server JSON-RPC** (мы только что трогали codex-launch — это
   следующий, качественно иной уровень: убирает pty-скрейп для codex целиком).
2. **#9 SQLite event-log** — предпосылка под live-клиент; без него мульти-клиент/курсор не выводятся.
3. **#20 SSH-туннель remote** — дешевле всего, SSH-субстрат уже есть; открывает «флот с телефона».
4. **#23 resource-monitor сайдкар** — закрывает реальную боль (нет монитора, TUI жёг ядро), протокол
   готов почти как спека.
5. **#24 release-smoke + mock-update-server** — гасит целый класс наших self-update багов на билде.

# Что НЕ переносим
- effect-ts машинерия (Layers/Fibers/PubSub/Schedule) — переносим ПАТТЕРНЫ, не рантайм; порт
  `effect-acp` целиком затащит весь effect. Для ACP — лёгкий ndjson-JSON-RPC поверх `Bun.spawn`.
- Их boot — Linux/systemd-only (macOS launchd — их gap); ccmux уже кроссплатформенный.
- Их «нет tmux-персиста» — наш tmux-survives-reboot + SSH-attach сильнее, не отдаём.

# Открытые вопросы / проверить перед адаптацией
- Версия установленного Codex действительно ли даёт `thread/*`+`turn/*` app-server протокол (есть
  старый `newConversation`/`sendUserTurn`) — проткнуть `codex app-server` пробником.
- Claude Agent SDK `query()` с resume-курсором — даёт ли всё, что нам нужно, headless, и как это
  сосуществует с tmux-UX (интерактивный CLI vs SDK — возможно ДВА режима сессии).
