---
title: Инкрементальный учёт расхода сессий
description: Native usage, SQLite checkpoints, bounded запросы и явная полнота измерений без выгрузки переписки.
status: active
created: 2026-09-09 15:37 +07:00
updated: 2026-09-09 15:43 +07:00
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

Daemon обходит managed/наблюдаемые external/явно запрошенные адреса по очереди: одна порция
до 64 КиБ каждые 100 мс, skip overlap, shutdown/cancel через application lifecycle.
Head-проверка при индексировании читает дополнительно до 4096 байт. Незавершённая строка
переносится между порциями; record свыше 16 МиБ пропускается с malformed evidence.
Transcript сохраняет полное initial indexing и прежние absolute-line cursors.

Новый временной query строится порциями до 500 contributions при повторных запросах, до ready
возвращая building. До 32 prepared queries на ledger. Warm read берёт totals и свою страницу,
не парсит history и не записывает агрегаты. Correction не пересчитывает весь ledger или все дни.
Bucket page: до 100 строк и 64 КиБ. Summary/machine page: до 256 КиБ. Control reads: concurrency 4,
admission 6 секунд, contract 7 секунд; cancellation проходит до external lookup.
Очередь явно запрошенных источников ограничена 512 адресами.

`source` (readable/missing/unreadable/unsupported) независим от `state`
(building/ready/stale/failed). Malformed/index lag/replay gap/backfill absence не выглядят full.
`observedAt` — время индексирования, не mtime. Vanished external сохраняет только ранее
проверенный identity/cache как stale/partial. Persistence failure — accounting-unavailable
и полная причина во внутреннем логе. Ошибочные provider counts не превращаются в нули.

External использует configured roots, metadata UUID, ownership/permissions/symlink/identity
проверки. Unchanged metadata cache требует той же identity/size/mtime. Caller path не принимается.
В ответе нет messages, prompt, tool arguments, credentials, storage paths или исходных ошибок.

# Проверка

`test/usage*.test.ts`: normalization/correction, timestamps, byte pages, restart/rollback,
invalidation, live metadata, daemon fairness/shutdown, настоящий Unix/CLI/remote-prefix путь.
Packed client gate включает typed usage call. `bun scripts/measure-usage.ts` измеряет синтетическую
историю: max/P95 backfill/warm, append, reply bytes и sampled RSS, без доступа к native runtime.
