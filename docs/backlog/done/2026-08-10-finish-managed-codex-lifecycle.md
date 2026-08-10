---
title: Завершить managed Codex new/reconcile/restart/self-heal lifecycle
description: Довести первый запуск Codex до точной thread identity и проверить transactional create, restart и self-heal
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:13 +07:00
---

## Зачем

Внутренний provider для `agent: codex` уже умеет launch, resume и чтение transcript. Предыдущая
этажка добавила strict `agent` в registry и публичный CLI `ccmux new ... --agent codex`, но первый
запуск всё ещё небезопасен: временный UUID записывается как будто это thread identity, а реальный
rollout выбирается по `cwd + mtime`. Две одновременные Codex-сессии в одном cwd могут поменяться
rollout-ами, а supervisor после reconcile продолжает держать старую запись и после смерти child
создаёт ещё один thread вместо resume.

Компоненты проверялись по отдельности, но живой цикл `new → reconcile → heal → restart → resume`
через daemon и tmux не был пройден целиком. Без такого e2e поддержка Codex существует в коде, но
не является доступной пользовательской возможностью.

## Результат

- Codex можно явно выбрать через CLI и TUI без ручного редактирования registry; Claude остаётся
  TUI default.
- Создание является одной транзакцией: provider preflight → pending launch → exact rollout bind →
  ready registry record. CLI/TUI возвращают успех только после authoritative UUID.
- Pending correlation никогда не выдаётся за thread UUID и не участвует в transcript/routing.
- Первый rollout привязывается по persisted launch marker, а не по cwd/mtime/source; promotion
  выполняется CAS-операцией и не может перезаписать удалённую/пересозданную запись.
- Полный живой self-heal цикл проверен на реальном Codex TUI, включая restart и восстановление после
  смерти процесса.
- Help, README и architecture docs описывают реально доступный интерфейс без несуществующих флагов.

Managed identity всегда включает `agent: codex`; совпадающий cwd с Claude-сессией не объединяет их
и не влияет на выбор provider.

## State machine

- `pending`: отдельная persisted launch transaction с generation/token; это не Session и не peer.
  Ровно один fresh Codex child может принадлежать generation.
- `ready`: canonical registry Session с реальным Codex rollout UUID. Только это состояние доступно
  list/transcript/routing/restart/chat consumers.
- `blocked`: durable lifecycle error для terminal ownership/resume failure; retry не создаёт fresh
  thread и не входит в hot loop.
- Promotion `pending → ready` атомарно проверяет name, agent, generation и уникальность UUID. Любая
  поздняя/неоднозначная promotion теряет гонку безопасно.

## План

- [x] Baseline: strict explicit `agent`, CLI `new --agent claude|codex`, provider launch/resume/
  transcript/list уже реализованы предыдущей этажкой.
- [x] Эмпирически проверить на обычном Codex TUI persisted launch marker и active-writer resume
  failure в полностью изолированном state/CODEX_HOME/tmux.
- [x] Добавить persisted pending transaction, locked CAS promotion и provider preflight; deterministic
  config/spawn/reconcile errors откатывают только ту же generation и не оставляют registry/tmux residue.
- [x] Перенести first-launch reconcile в supervised lifecycle: exact marker match, 0/>1 candidates =
  terminal failure; удалить cwd/mtime selector и не разрешать fresh retry после первого spawn.
- [x] На каждом child launch перечитывать canonical Session; ready с missing history падает fail-first,
  Codex ownership conflict становится blocked без Claude fork recovery/retry storm.
- [x] Провести CLI и TUI через один transactional create service; добавить TUI provider selector с
  Claude default и runtime AgentKind validation.
- [x] Сделать managed termination provider-neutral: restart ждёт смерти собственного child/process
  group до resume; не использовать external/Desktop writer discovery.
- [x] Пройти изолированную lifecycle matrix и обновить help, README, architecture и тесты.

## Не входит

- External Codex discovery, ownership, cold adopt, fork/takeover. Этим владеет отдельная задача
  `2026-08-10-discover-and-own-external-codex-threads.md`; текущий `adopt` остаётся явно Claude-only.
- Managed Codex chat delivery — отдельная следующая capability-задача.
- Release, stage/update установленного ccmux и любые действия с production daemon.

## Acceptance

- [x] CLI и TUI Codex create возвращают success только после записи real rollout UUID; до promotion
  list/transcript/routing не видят pending как Session.
- [x] Две одновременно созданные Codex-сессии в одном cwd получают разные правильные UUID по своим
  persisted marker независимо от порядка mtime; Claude+Codex в том же cwd также независимы.
- [x] Promotion проигрывает безопасно при rm/recreate/другом claim, сохраняет unrelated registry edits
  и не оставляет pane/pending/registry half-state.
- [x] Смерть только Codex child оставляет `_run` и запускает `codex resume <тот же UUID>` без нового
  rollout; смерть tmux/_run и restart daemon heal-ятся к тому же UUID/history/provider.
- [x] При выключенном daemon `stop → start`, single restart и restart-all сохраняют UUID/history/
  provider и дожидаются смерти прежнего managed writer.
- [x] Active-writer resume conflict и missing ready history переходят в явную terminal/blocked ошибку
  без retry storm, fresh fallback или второго writer.
- [x] Первый launch crash/timeout/0/>1 marker match не создаёт повторный fresh child; rollback удаляет
  только ту же pending generation и сохраняет rollout-файлы.
- [x] External Codex adopt не реализуется и остаётся документированно Claude-only.
- [x] Live probes используют temp workspace, temp CODEX_HOME с копией только auth, temp state и
  dedicated tmux socket; source CLI; cleanup через finally; production daemon/release не затронуты.
- [x] Два read-only валидатора проверили план, затем два — код и живой lifecycle.

## Конвейер 2/2

- [x] Валидатор плана 1: CLI/TUI/schema/provider boundaries — CLI baseline учтён, adopt вынесен,
  добавлены pending/ready transaction, exact correlation и shared TUI/CLI create.
- [x] Валидатор плана 2: lifecycle races, rollback и ownership safety — добавлены CAS generation,
  stale supervisor fix, terminal ownership state и изолированная live matrix.
- [x] Валидатор реализации 1: PASS после проверки registry/journal/rollback/blocked races и failure tests.
- [x] Валидатор реализации 2: PASS после проверки безопасного live probe, TUI/observability/docs/privacy.

## Правки валидатора-1

- Убран устаревший пункт про CLI `--agent`: он уже является проверенным baseline.
- `adopt` полностью вынесен в external Codex task.
- Зафиксированы deterministic correlation, shared transactional create и reload registry на каждом
  child launch.
- Добавлены provider-neutral termination gate и decisive CLI/TUI/live failure matrix.

## Правки валидатора-2

- Placeholder заменён явной persisted pending generation, которая не является thread identity.
- Promotion определена как locked CAS; ambiguity/timeout/rm-recreate не могут записать поздний UUID.
- Fresh launch разрешён один раз, terminal ownership/reconcile ошибки не retry-ятся.
- Stop/start проверяется отдельно с выключенным daemon; child/tmux/daemon heal — с включённым.
- Live probes полностью изолированы от production state и установленного ccmux.

## Правки валидаторов реализации

- Reservation pending/ready сведён под один registry lock; rollback убивает только tmux session с
  exact bootstrap generation и удаляет только matching registry/block identity.
- Promotion сделан crash-safe протоколом `promoted journal → ready → journal cleanup`; read view идёт
  journal-first, а recovery идемпотентно завершает обе write boundaries.
- Registry lock хранит PID + owner token, снимает только dead owner и никогда не удаляет чужой lock.
- Добавлены реальные `_bootstrap` failure tests для child crash, correlation timeout и ambiguous
  markers: один fresh invocation, без pane/pending/ready/block residue, rollout-файлы сохраняются.
- Live probe запускает Codex с `sandbox=read-only` и `approval=never`, проверяет exact assistant
  replies и всегда завершает children/tmux; KEEP сохраняет только файлы.
- Terminal blocked reason выведен в human/JSON list и TUI; TUI failure печатается после cleanup.

## Что сделано

- [x] **State/registry:** `src/config/pendingSessions.ts`, `sessionRegistry.ts`, `registryLock.ts`,
  `lifecycleBlocks.ts` реализуют pending/promoted/ready transaction, CAS, crash recovery и
  identity-scoped blocked state.
- [x] **Lifecycle:** `src/commands/create.ts`, `bootstrap.ts`, `run.ts`, `lifecycle.ts`,
  `restartAll.ts` проводят CLI/TUI через один create path, reload ready identity перед каждым child
  и сохраняют UUID через stop/restart/self-heal.
- [x] **Provider/TUI:** `src/agent/codex/correlation.ts` использует exact persisted originator marker;
  `src/tui/App.tsx` и `run.tsx` дают explicit Claude/Codex choice и видимую ошибку.
- [x] **Observability/docs:** `src/commands/list.ts`, `src/tui/components/SessionCard.tsx`, README и
  `docs/architecture/managed-codex-lifecycle.md` отражают provider, lifecycleError и journal protocol.
- [x] **Tests:** `test/codex-bootstrap-failures.test.ts`, `codex-lifecycle-state.test.ts`,
  `tmux-generation.test.ts`, `registry-lock.test.ts`, `tui-provider.test.tsx` закрывают positive,
  race и terminal failure paths.
- [x] **Live e2e:** `scripts/codex-managed-lifecycle-probe.ts` прошёл на `codex-cli 0.147.0`: child,
  stop/start, single restart, restart-all и daemon heal сохранили UUID/history; reverse writer
  conflict и missing history дали blocked без retry storm; same-cwd sessions получили разные UUID.
- [x] **Gates:** `bun run check` — 358 pass / 0 fail / 1066 expects; оба implementation validators — PASS.
- [x] **Не делалось:** release, stage/update установленного ccmux, production daemon/session mutation,
  external Codex adopt/discovery и managed Codex chat delivery.
