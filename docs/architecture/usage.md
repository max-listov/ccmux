---
title: Инкрементальный учёт расхода сессий
description: Native usage, SQLite checkpoints, bounded запросы и явная полнота измерений без выгрузки переписки.
status: active
created: 2026-09-09 15:37 +07:00
updated: 2026-09-30 07:58 +07:00
type: architecture
---

# Контракт

`usage.read` (`POST /control/usage`) принимает `address` и `query`.
`usage.list` (`POST /control/usage/list`) — `query`, machine-page `cursor` и `limit`.
Обе операции доступны через canonical control contract, Unix/injected client, contract CLI и MCP.

```sh
ccmux usage host-a:agent-a --json
ccmux usage host-a:app/11111111-1111-4111-8111-111111111111 --json
ccmux usage host-a:agent-a#abc123 --json
ccmux usage --fleet --since 2026-01-01T00:00:00Z --until 2026-02-01T00:00:00Z --timezone Europe/Berlin --json
```

Query: полуоткрытый UTC-интервал `[since, until)`, IANA `timezone` (default `UTC`, отражён в
ответе), `cursor`, `pipelineCursor`, `limit` 1–100. Интервал с двумя границами — до 366 дней.
Неизвестное event time и opening balance входят в `unattributed`, не приписываются дню и
исключены из interval self. Без интервала unattributed уже включён в lifetime self.

Bucket cursor привязан к источнику, query и revision. Append/correction дают старому cursor
`reset=true` и первую страницу. `reportedPipeline` имеет отдельный cursor (`--pipeline-cursor`).
Machine-list cursor закрепляет состав адресов, **не** одновременный снимок их расходов:
каждая строка несёт собственную revision и observation time.

CLI без адреса читает локальную страницу. `--fleet` делает один запрос на машину, не процесс
на каждую сессию; недоступные узлы остаются отдельными unavailable rows. Machine cursors
продолжаются запросами к соответствующим машинам, не общим `--fleet --cursor`.
Exit 0 — доступные готовые полные данные; 2 — partial/building/stale/unsupported;
1 — отказ запроса или accounting failure. Выдача всегда JSON.

# Смысл данных

`identity` разделяет managed session UUID и native session ID; external не притворяется managed.
`sourceEventRange.first/last` — крайние известные timestamps всего проиндексированного источника,
не гарантия непрерывного покрытия и не границы query. Null означает отсутствие event time.

`self.values`: независимые nullable input/output/cache-read/cache-creation/reasoning/total.
Missing не равен измеренному нулю. `measured` и `fieldCoverage` описывают каждое поле;
`observations` — contributions, не пользовательские ходы. Unsupported поле может быть unknown
при полном покрытии доступных полей; пропущенное измерение доступного поля означает partial.
Cache/reasoning не прибавляются к total автоматически. Bucket несёт nullable
`inputIncludesCache`/`outputIncludesReasoning`, модель/provider и доступную provenance.
Costs группируются по currency/provenance, не конвертируются и не выдаются за счёт провайдера.

| Источник | Identity / reducer | Покрытие |
| --- | --- | --- |
| Claude JSONL | Message ID, entry UUID при отсутствии native ID; replacement | Native history. Content blocks не умножают расход. Input исключает cache; доступные thinking details включены в output. |
| Codex JSONL | Raw `token_count.info.total_token_usage`, cumulative в session epoch | Native history независимо от display messages. Первый counter — opening balance, последующие — дельты. |
| OpenCode | Native assistant message ID, replacement до terminal filtering | Observed live, включая tool-call/compaction steps; полный historical backfill не утверждается. |
| Custom | Native conversation/run ID, terminal run metrics | Observed live; cacheWrite и cost provenance сохранены, replay gap не становится full. |
| Claude SDK | Query epoch + result UUID + model, cumulative | Отдельный query-pipeline-inclusive: main/Task/sidechain/compaction, не transcript self. |

Уменьшившийся cumulative counter без native epoch boundary — ambiguous/partial, не выдуманный
reset. Известные неотрицательные вклады сохраняются; partial итог не точная сумма и не
гарантированная нижняя граница. Missing baseline поля относит появившееся значение к unattributed.
SDK epochs создаются при `query()`; result без event timestamp не приписывается времени получения.
SDK cost — estimate. Доступные canonicalModel/provider/costBasis/thinking/webSearchRequests/
contextWindow/maxOutputTokens сохраняются в metadata buckets; это факты источника, не суммы
context windows или web-search counters между buckets.

Claude child читается по `<managed-address>#<agent-id>`. `delegated.addresses` ограничен 100,
полнота дерева не утверждается. Child self и SDK pipeline не прибавляются к parent.
`additivity=session-only`: fork/cross-machine copies не имеют доказанной глобальной charge identity.
Fleet поэтому отдаёт `total=null`, `totalReason=cross-session-lineage-unproven`, а не двойной расход.
Managed Codex identity исключается из external списка той же машины.

# Хранение, границы и отказы

Один UsageFact reducer обслуживает CLI/control/transcript stats/subagent usage. JSONL checkpoint,
facts и contributions коммитятся одной SQLite transaction в derivable cache. Checkpoint хранит
newline/read offsets, pending UTF-8 bytes, inode/head digest/mtime, malformed count и время
индексирования. Truncation/replacement/runtime change инвалидируют derived index; JSON index
не читается как compatibility-источник. Native transcript не изменяется.

Live-only ledger находится в `stateDir/usage`, вне cache и rotating diagnostics. Replay по
identity не меняет его. Correction атомарно заменяет вклад и затронутые buckets; cumulative
correction обновляет также следующую дельту. SQLite сериализует writers.

Хранилище работает в WAL: читатель не ждёт writer'а ни в очереди за write lock, ни пока тот
коммитит или держит сброшенную на диск транзакцию. Rollback journal в эти моменты не даёт даже
shared lock, и простой `SELECT` читателя отказывал после busy timeout. Режим хранится в файле и
ставится при открытии, если его ещё нет; переключение, которому мешает чужое открытое соединение,
повторяется при следующем открытии. Файлы `-wal` и `-shm` лежат рядом с индексом в каталоге кэша.

Открытие хранилища — чтение: схема и начальная строка `revision` пишутся только когда их нет в
`sqlite_master`, поэтому читатель не встаёт в очередь за процессом, который продвигает тот же
индекс. Из двух процессов, продвигающих индекс одного transcript, write lock получает один;
второй после busy timeout (1 с) берёт последний закоммиченный индекс — он верен до своего offset —
и дочитывает остаток файла в памяти, ничего не записывая: окно `tail` включает строки, дописанные
после последнего коммита, а факты расхода за этот остаток записывает процесс, держащий lock.
Индекс, который уже не совпадает с файлом, и любая другая ошибка SQLite остаются отказом.

Чтение расхода тоже пишет: кэш запроса (итоги и buckets) достраивается в той же транзакции записи.
Если write lock держит другой процесс дольше busy timeout, чтение отвечает только чтением из
закоммиченного — последний сохранённый кэш запроса, `building`, если он был неполным, а без кэша
пустой `building` — и оставляет достройку следующему чтению, получившему lock. Кэш делает ответ
дешёвым, но ответом не является, поэтому занятый lock не превращает расход в `accounting-unavailable`.

Daemon выполняет bounded порции до 4 МиБ каждые 100 мс, skip overlap,
shutdown/cancel через application lifecycle. Три тика из четырёх отданы round-robin очереди
явных address + normalized query; четвёртый — фоновому обходу managed/external inventory.
Без очереди все тики доступны inventory. Один проход передаёт свой свежий registry snapshot
в подготовку и identity projection; `usage.list` использует один snapshot на страницу.
Читатель не запускает полный scan истории.

Для managed и external history inventory хранит только fingerprint успешно подготовленного источника,
без SQLite handles и без готовых ответов. На каждом посещении адреса проверяются source path,
inode/size/mtime/ctime/ownership, session/config, child inventory и main/WAL/SHM metadata
индекса и live ledger. Неизменившийся готовый источник не запускает индексирование,
aggregate queries и сборку response. Новые и изменённые источники используют прежние bounded
порции; незавершённый query cache продолжает catch-up. Полностью прочитанный source с partial
record ждёт изменения файла; его readiness остаётся `building`. Ошибка не запоминается как
готовность. Изменение source во время подготовки требует нового прохода. Удалённые адреса
убираются из fingerprint inventory. Fingerprint живёт в экземпляре schedule; новый экземпляр
начинает без него.

Архив входит в тот же round-robin: cold source подготавливается, затем проверяется metadata
без непрерывного открытия SQLite. Явный `usage.read`, новая временная query и requested queue
проходят обычную подготовку независимо от fingerprint inventory. Для external source каждый
проход выполняет canonical lookup с проверкой configured roots, permissions, ownership, symlink
и thread identity. Fingerprint сокращает только подготовку usage; запомненный path не заменяет
проверку доступа. Изменения другого writer видны
при следующем посещении адреса; частота schedule и правило трёх requested тиков из четырёх
сохраняются.
Head-проверка при индексировании читает дополнительно до 4096 байт. Незавершённая строка
переносится между порциями; record свыше 16 МиБ пропускается с malformed evidence.
Transcript сохраняет полное initial indexing и прежние absolute-line cursors.

Новый временной query строится порциями до 500 contributions и регистрируется в фоновой очереди:
одного обращения достаточно для завершения в работающем daemon. `building` возвращает
`retryAfterMs=1000`. До 32 prepared queries на ledger; незавершённые query не вытесняются новыми.
Warm read берёт totals и свою страницу,
не парсит history и не записывает агрегаты. Correction не пересчитывает весь ledger или все дни.
Bucket page: до 100 строк и 64 КиБ. Summary/machine page: до 256 КиБ. Control reads: concurrency 4,
admission 6 секунд, contract 7 секунд; cancellation проходит до external lookup.
Очередь ограничена 512 query. Она живёт в daemon; после его рестарта чтение заново регистрирует
незавершённый запрос, а persistent checkpoints и query caches сохраняют прогресс.

Для окна с `until` `sourceCoverage` фиксирует byte-boundary наблюдаемого источника.
`basis=source-snapshot`, `targetBytes`, `throughBytes`, `complete` описывают ровно прочитанное
покрытие. После достижения boundary и построения query ответ становится `ready`, даже если
источник продолжает расти. Это полнота snapshot, а не гарантия отсутствия будущих correction
records: event timestamps не обязаны возрастать. Дальнейшее индексирование исправляет totals
и revision по поздним данным. Замена файла инвалидирует boundary. Пустое готовое окно отвечает
`reason=no-usage-observations`; `null` метрики не превращаются в нули.

`source` (readable/missing/unreadable/unsupported) независим от `state`
(building/ready/stale/failed). Malformed/index lag/replay gap/backfill absence не выглядят full.
`observedAt` — время индексирования, не mtime. Vanished external сохраняет только ранее
проверенный identity/cache как stale/partial. Persistence failure — accounting-unavailable
и полная причина во внутреннем логе. Ошибочные provider counts не превращаются в нули.

External использует configured roots, metadata UUID, ownership/permissions/symlink/identity
проверки. Unchanged metadata cache требует той же identity/size/mtime/ctime. Caller path не принимается.
В ответе нет messages, prompt, tool arguments, credentials, storage paths или исходных ошибок.

# Проверка

`test/usage*.test.ts`: normalization/correction, timestamps, byte pages, restart/rollback,
invalidation, live metadata, daemon fairness/shutdown, настоящий Unix/CLI/remote-prefix путь.
`test/usage-preparation.test.ts` проверяет fingerprint invalidation, correction, partial source,
cold query catch-up, live ledger и SQLite contention. `test/daemon-idle-usage.test.ts` запускает
полный изолированный daemon: подготовленные managed archive и external thread не открываются
повторно, requested window
достраивается и поздняя correction видна через настоящий Unix control client. Возврат
безусловной подготовки опровергается изменением ctime соответствующего индекса.
`test/usage-external-preparation.test.ts` проверяет append/archive, permissions, managed ownership,
symlink и замену identity с восстановленным mtime. Ошибка создания `UsageStore` закрывает
уже открытое SQLite соединение; счётчики store отражают opens, active и peak handles.
`bun scripts/daemon-idle-bench.ts <seconds> <output.json>` измеряет CPU/memory полного application
с 29 managed sessions (18 running, 11 archived), 9 внешними synthetic Codex threads,
отдельными tmux/config/state/cache/provider roots и 15-секундным cold окном. Native provider
заменён read-only synthetic App Server без inference. Worker находится в `daemonIdleWorker.ts`
и входит в TypeScript gate; `--baseline=<bundle>` использует заранее собранный worker.
`--only=<schedule-id>` — отдельный диагностический режим: после общего прогрева остаётся один
schedule, остальные callbacks перестают выполняться; 3,5 секунды даются на их завершение.
Режим `--only=none` измеряет остаточную стоимость application. Эти CPU/I/O числа относятся
к изоляции schedule, а не к его точной доле в одновременно работающем полном daemon.
Обычный полный benchmark сохраняет все schedules. Duration проверяется монотонными часами
и не заканчивается раньше указанного steady-state интервала.
Mac workload не измеряет Linux OOM pass; worker profiling запускается отдельно через `--profile`.
Packed client gate включает typed usage call. `bun scripts/measure-usage.ts` измеряет синтетическую
историю: max/P95 backfill/warm, append, reply bytes и sampled RSS, без доступа к native runtime.


Registry и machine config проверяют disk revision при каждом обращении. Версия файла включает
наносекундные mtime/ctime, dev/inode, size, mode и uid; configured symlink проверяется по target.
Неизменившийся файл не разбирается повторно. Ready registry и pending journal имеют отдельные
snapshot readers, поэтому порядок journal → ready при promotion сохраняется. Каждый reader
держит один parsed snapshot и возвращает собственные объекты caller. Ошибка нового разбора
не отдаёт прежний snapshot. Machine binary detection и env overrides выполняются при каждом
вызове; результаты целиком не кешируются. `test/file-snapshot.test.ts` проверяет отдельного
writer, mutation caller, atomic replacement, restored mtime, symlink target, malformed config
и promoted journal. Метрики files разделяют revision checks и повторные loads.
