---
title: ccmux live client — realtime web/mobile (стрим транскрипта + управление флотом)
description: Превратить ccmux в приложение — WebSocket-сервер стримит живой транскрипт и статус флота в веб/мобайл-клиент; оттуда пишешь агентам и рулишь сессиями откуда угодно
type: task
status: planned
created: 2026-06-09
updated: 2026-06-09
related: docs/backlog/inbox/2026-06-09-tmux-control-mode.md
---

## Видение
ccmux уже держит флот живых агентов. Добавляем **сервер + клиент**: видеть весь флот и
**живые транскрипты** с телефона/браузера, писать агентам, рулить сессиями — откуда угодно.
«Агентский отдел в кармане». Poll — в утиль, всё событийное/реалтайм.

## КЛЮЧЕВОЙ ИНСАЙТ (почему готовность высокая)
**Живой транскрипт = watch JSONL-файла, НЕ tmux.** Беседа claude/codex лежит в append-only
`~/.claude/projects/<enc>/<uuid>.jsonl`. Мы его уже парсим (адаптеры). Для realtime —
`fs.watch` + дочитка с последнего offset + инкрементальный парс → пуш клиентам. **tmux
control mode не требуется** для транскрипта (он нужен лишь для сырого терминал-пейна — поздняя
опция). Это снимает самый сложный кусок.

## Что УЖЕ есть (переиспользуем)
- Транскрипт-адаптеры (jsonl → unified messages) — `src/agent/*/transcript.ts`, `normalize.ts`.
- Модель флота — `collectRows`, `loadSessions`, статусы (`status.ts`).
- Действия — `sendMessage` (send-keys), lifecycle (new/stop/restart/rm).
- **Bun нативно**: `Bun.serve` с WebSocket + статикой (HTML-импорты, React) — без express/ws.
- Рендер-концепты (ChatMessage/Markdown/SessionCard) — портируются в веб.

## Что НОВОЕ
- **JSONL-watcher**: `fs.watch` каждого активного jsonl, tail с offset, инкрементальный парс,
  обработка ротации/резюма (resume может перезаписать — следить за inode/truncate).
- **WebSocket-сервер** + протокол (subscribe/snapshot/delta/command).
- **Auth** (token в machine.json `serverToken`), т.к. удалённый доступ.
- **Веб-клиент** (Bun.serve + React, high-end дизайн) → PWA (installable на телефон).
- **Удалённый доступ** (tailscale / cloudflare tunnel) — ops, не код.

## Архитектура
```
[claude в tmux] → пишет jsonl ──watch──┐
[tmux pane status] ──scrape/control──┐ │
                                     ▼ ▼
                          ccmux daemon + СЕРВЕР (Bun.serve WS)
                          - watch jsonl всех сессий → live messages
                          - модель флота (list+status)
                          - команды → send-keys / lifecycle
                                     │ WS (token auth, через tailscale)
                          ┌──────────┼───────────┐
                       web-PWA   mobile        (CLI/TUI как сейчас)
```

## WS-протокол (черновик)
- `auth {token}` → ok/err
- `subscribe-fleet` → `fleet {sessions[]}` снапшот + пуши `fleet-update`
- `subscribe-session {name}` → `transcript-snapshot {messages[]}` + пуши `message {…}` (дельта) + `status {…}`
- `command {action: send|new|stop|restart|rm, name, text?}` → `ack`/`error`

## Фазы
### Фаза 1 — Стрим-фундамент (сервер + watch + протокол) ⭐ начать с неё
- [ ] `src/server/jsonlWatch.ts` — watch активных jsonl, tail-from-offset, инкрементальный парс через адаптер → emitter новых сообщений
- [ ] `src/server/index.ts` — `Bun.serve` WS; subscribe-fleet / subscribe-session; снапшот + дельты
- [ ] `src/commands/serve.ts` (или флаг в daemon) — поднять сервер; `serverPort`/`serverToken` в схеме
- [ ] Тест: подписка из `wscat`/скрипта → видим живые сообщения по мере того как агент пишет

### Фаза 2 — Команды
- [ ] WS `command` → `sendMessage`/lifecycle; ack + ошибки
- [ ] Auth-token (machine.json `serverToken`), reject без него

### Фаза 3 — Веб-клиент (MVP, high-end)
- [ ] Bun.serve статика + React (HTML-импорты); WS-клиент
- [ ] Флот-лист + живой транскрипт (порт ChatMessage/Markdown), инпут отправки
- [ ] PWA-манифест → ставится на телефон как апп

### Фаза 4 — Удалённый доступ
- [ ] Tailscale (телефон в тейлнете → достаёт мак) ИЛИ cloudflare tunnel; HTTPS; token
- [ ] (опц.) на серверах: демон-сервер + nginx-reverse-proxy

### Фаза 5 — Мобайл / уведомления (опц.)
- [ ] Push: «агент ждёт ввода» → телефон жужжит (waiting-статус → notification)
- [ ] Если PWA мало — нативный Expo

### Фаза 6 — Сырой терминал-пейн в вебе (опц., вот тут control mode)
- [ ] xterm.js в вебе + стрим пейна через tmux control mode `%output` / `pipe-pane`
- [ ] Только для «как в терминале» вида; транскрипт-вид (Фазы 1-3) важнее и проще

## Готовность / риски
- **Готовность ВЫСОКАЯ**: данные (jsonl) + действия (send-keys) + транспорт (Bun WS) уже есть.
  Новое — watcher + WS-протокол + веб-UI. Фазы 1-4 (живой транскрипт + команды + веб + удалёнка)
  **не требуют control mode** — самый сложный кусок отложен в опциональную Фазу 6.
- Риски: edge-cases jsonl (ротация/резюм/truncate); безопасность удалённого доступа (token+tailscale,
  не публичный порт); консистентность снапшот↔дельты (offset/seq).

## Acceptance
- [ ] С телефона/браузера: вижу флот + живой транскрипт выбранной сессии в реальном времени
- [ ] Оттуда же пишу агенту и создаю/рулю сессии
- [ ] Доступ безопасный (token + tailscale/tunnel), poll не используется — всё событийное
