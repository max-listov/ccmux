---
title: Обнаруживать внешние Codex threads и атомарно принимать ownership
description: Добавить source-aware inventory и безопасные adopt/fork/takeover transactions для внешних Claude и Codex threads
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 14:00 +07:00
---

## Зачем

External discovery сейчас Claude-only: процессный collector, transcript reader, TUI identity и
`adopt` предполагают Claude JSONL. Codex rollout и его persisted origin (`cli`, `vscode`,
`appServer`, ...) не попадают в inventory, а существующий Claude fork через копирование JSONL и
takeover через безусловный `SIGTERM` для Codex небезопасны.

Read-only observation не доказывает, что Codex thread свободен. `notLoaded`, отсутствие PID или
неудерживаемый lock-файл остаются advisory evidence; authoritative ownership transition — только
успешный `codex resume <uuid>` самим будущим managed process. Поэтому discovery и admission должны
быть разными слоями, а Desktop/shared App Server нельзя останавливать как один thread.

## Результат

- ccmux показывает внешние Claude и Codex threads отдельными provider-neutral items. Identity —
  `plane + host + provider + threadId`; cwd, path, mtime и origin — только metadata.
- Codex item отдельно несёт persisted `origin`, storage observation, writer evidence, runtime kind,
  доступные actions и причину недоступности остальных. `source` никогда не трактуется как ownership.
- Explicit Codex adopt использует существующую pending/promoted/ready transaction: один ordinary
  process-TUI `codex resume`, promotion только после admission; conflict/crash/timeout откатывают
  exact generation без ready row, pane и retry storm.
- Codex fork выполняется provider-native ordinary TUI `codex fork <sourceUuid>`, коррелирует новый
  rollout launch marker + `forked_from_id`, сохраняет source и атомарно промоутит новую identity.
- Takeover недоступен для Desktop/vscode, App Server, shared, self/ancestor и unknown writer.
  Dedicated CLI можно остановить только после отдельного подтверждения и fresh revalidation exact
  UUID/PID/start-time/process-group; после остановки ownership всё равно получает atomic resume.
- Desktop-native task plane остаётся отдельным: external visibility не создаёт Desktop control,
  ccmux ledger/chat capability или право записи.

## Модель

Provider-neutral external DTO валидируется Zod и не переиспользует managed `Session`:

- `provider`: `claude | codex`;
- `host` + `threadId`: стабильная route identity;
- `origin`: persisted origin metadata (`cli | desktop | vscode | app-server | exec | subagent | unknown`),
  не текущий writer;
- `storage`: `stored | missing | unknown`;
- `writerEvidence`: `observed | none-observed | unknown`;
- `writerRuntime`: `managed | dedicated-cli | desktop | vscode | app-server | shared | self | unknown` плюс точные
  process evidence, когда они доказаны;
- `admission`: результат transient ownership transaction (`accepted | conflict`), а не поле inventory DTO;
- `capabilities`: вычисляемые inspect/attemptAdopt/fork/terminateAndAdopt/releaseAtSource с reason.

`none-observed` не означает free. Unknown запрещает прямую регистрацию и takeover, но explicit
`attemptAdopt` может запустить ровно одну authoritative admission transaction. React/selection key
строится одним helper: managed включает plane/provider/machine/name/UUID, external —
plane/provider/host/thread UUID; origin в key не входит.

## Границы

- Codex writer correlation опирается на OS-held lock `$CODEX_HOME/thread-writer-locks/<uuid>.lock`;
  argv и App Server loaded state — только enrichment. Нужен first-class `codexHome`, а не вывод lock
  root из произвольного `codexSessionsDir`.
- Inventory берёт union persisted rollout UUID и UUID из lock filenames с положительным OS-holder
  evidence. Поэтому fresh pre-turn writer видим как `storage=missing`, `writerEvidence=observed`,
  `cwd/origin=unknown`; один stale lock filename item не оживляет.
- TUI inventory на этой этажке локальный. Remote `fleet/list --json` остаётся managed-only; внешний
  versioned fleet wire — отдельная задача, а не скрытое расширение существующей схемы.
- Claude provider сохраняет свои transcript/writer/fork adapters; Codex никогда не копирует и не
  переименовывает rollout JSONL и не использует mutating observer App Server.
- Adopted-in-place Codex session lifecycle-managed, но не получает ccmux management/router prompt:
  resume не добавляет скрытый user turn. Chat/router capability остаётся выключенной до отдельной
  calibrated delivery этажки. Fork management prompt допустим только как явный turn новой identity.
- Реальный Desktop process/default socket/PID не трогаются ни probe, ни takeover тестом.

## План

- [x] Изолированно откалибровать Codex 0.147: lock ownership для CLI/App Server, native fork при
  удерживаемом source writer, persisted marker/`forked_from_id`, resume conflict и post-owner resume.
- [x] Ввести strict external identity/evidence/capability schemas, stable selection key helper и
  first-class `codexHome`; разделить provider collectors и transcript adapters.
- [x] Реализовать Codex rollout inventory из persisted `session_meta` и lock/process observer для
  macOS/Linux; отсутствие evidence не превращать в writable/dead.
- [x] Перевести App/FleetItem/cards/actions на exact external identity, source/evidence/capability UI
  и fresh re-resolution перед каждым action; same cwd/UUID/provider rows не схлопывать.
- [x] Обобщить managed pending bootstrap на provider operations `create | adopt | fork`: single
  resume/fork child, exact correlation, CAS promotion, exact-generation rollback и terminal block.
- [x] Разделить provider actions: Claude adapters остаются Claude-specific; Codex adopt/fork идут
  через process TUI; takeover сигналит только fresh-proven dedicated CLI instance.
- [x] Обновить CLI/help/README и architecture reference без обещания external fleet или Desktop
  control plane; убрать blanket `a adopt` там, где capability недоступна.
- [x] Прогнать deterministic fixtures, isolated live matrix и полные gates; затем два независимых
  implementation validators.

## Acceptance

- [x] Identity fixture с managed/external Claude/Codex, одинаковыми cwd и намеренно одинаковыми UUID
  даёт четыре stable selectable keys; resort и stale click не меняют action target.
- [x] Stored origins `cli/vscode/app-server`, malformed/new source, pre-turn observed writer без rollout и
  stale mtime/lock дают честные storage/writer observations; unknown никогда не становится Claude/free.
- [x] Codex lock observer покрыт macOS/Linux fixtures; argv без UUID не ломает lock→thread mapping;
  managed exact provider+UUID исключается из external inventory.
- [x] Cold/no-writer-observed adopt сохраняет тот же UUID только после real resume admission; held
  CLI/App Server, simultaneous adopt и TOCTOU contender дают conflict + zero ready/pane/pending/retry.
- [x] Crash/timeout/zero/ambiguous correlation откатывают только свою generation и не трогают
  replacement, source rollout или другие registry rows.
- [x] Native Codex fork на active CLI source создаёт новый UUID, содержит прошлую
  history, пишет последующий turn только в fork; source rollout/owner остаются неизменны и живы.
- [x] Dedicated CLI takeover требует two-step confirm + fresh PID/start-time/process-group check;
  PID reuse/evidence change/respawn abort. Desktop/vscode/app-server/shared/self/unknown никогда не
  получают signal и показывают `release at source`.
- [x] Card показывает provider/host/full UUID/origin/writer/capabilities/reasons; cwd только subtitle.
  TUI local-only boundary и Desktop zero-ledger/control boundary отражены в docs.
- [x] Live probe использует temp workspace/CODEX_HOME/state/tmux socket, auth-only copy,
  `-s read-only -a never`, bounded commands и unconditional process/tmux cleanup; KEEP сохраняет
  только файлы. Committed output не содержит private paths/hosts/session IDs/PIDs/auth.
- [x] `bun run check` зелёный: 385 tests / 0 fail; два plan validators и два implementation validators дали PASS.

## Конвейер 2/2

- [x] Валидатор плана 1: process/App Server evidence и state semantics — потребовал advisory-only
  discovery, lock-based writer evidence, transactional resume/fork и dedicated-only takeover.
- [x] Валидатор плана 2: TUI identity и destructive boundaries — потребовал independent state axes,
  exact fresh target resolution, shared-runtime non-kill policy и explicit capability UX.
- [x] Валидатор реализации 1: PASS — collectors/schema/tests, identity races и destructive boundaries.
- [x] Валидатор реализации 2: PASS — live writer conflicts, cold adopt, fork/takeover behavior и cleanup.

## Правки валидатора-1

- Persisted Codex `source` переименован в origin semantics; writer/runtime ownership отделены.
- `cold adopt after proven free` заменён на atomic admission самим managed TUI.
- В план добавлены first-class `codexHome`, lock evidence, operation-aware pending transaction и
  полный rollback/concurrency matrix.
- Codex byte-copy fork запрещён; закреплён provider-native `codex fork`.
- Inventory объединяет rollouts с положительно удерживаемыми pre-turn locks; adopted resume не
  притворяется получившим management/chat prompt.

## Правки валидатора-2

- Takeover ограничен exact dedicated CLI; Desktop/App Server/shared/self/unknown — release at source.
- Stable selection key включает plane/provider/host/address/UUID; action всегда re-resolve fresh row.
- Зафиксированы pre-turn discovery limitation, local-only external inventory и capability/reason UI.
- Live probes полностью изолированы и не трогают реальный Desktop runtime.

## Что сделано

- [x] Shared: provider-neutral external identity, evidence, runtime и capability schemas добавлены в
  `src/config/schema.ts`; managed/external stable keys разделены.
- [x] Discovery: Claude и Codex collectors разделены в `src/external/`; Codex inventory объединяет
  persisted rollout metadata и положительно удерживаемые exact writer locks.
- [x] Ownership: `src/commands/adopt.ts`, `src/commands/bootstrap.ts` и provider adapters реализуют
  generation-scoped atomic adopt/fork promotion и rollback без прямой регистрации по discovery.
- [x] Codex: `src/agent/codex/correlation.ts` коррелирует fresh/fork rollout по provider metadata,
  exact launch marker и `forked_from_id`, без cwd/mtime selection и fixed head limits.
- [x] Takeover: `src/external/codex.ts` разрешает signal только fresh-revalidated exact configured
  dedicated CLI; Desktop/editor/App Server/shared/self/unknown остаются release-at-source.
- [x] TUI: `src/tui/fleet.ts`, `src/tui/externalView.ts`, `src/tui/App.tsx` и session views показывают
  provider, origin, full UUID, evidence, capabilities/reasons и re-resolve exact row перед action.
- [x] Verification: `test/external-discovery.test.ts`, `test/codex-takeover.test.ts` и связанные suites
  покрывают DTO, locks, selection, admission, rollback и non-signal matrix; полный gate — 385/0.
- [x] Live: `scripts/codex-external-ownership-probe.ts` на codex-cli 0.147.0 подтвердил CLI/App Server
  writer conflicts, zero-residue rollback, inherited native fork with fork-only turn и same-UUID cold adopt.
- [x] Docs: `docs/architecture/external-session-ownership.md`, README/help и TUI wording фиксируют
  advisory discovery, atomic admission, local-only external inventory и Desktop zero-control boundary.
- [x] Не делалось: release/stage/update/prod daemon не запускались; remote external fleet inventory и
  managed Codex chat остаются отдельными задачами.
