---
title: Транскрипт-адаптеры (мульти-агент)
description: Как ccmux читает историю сессии разных агентских CLI (Claude Code, Codex) через единый контракт
type: architecture
status: active
created: 2026-06-09
updated: 2026-09-12 15:48 +07:00
---

# Транскрипт-адаптеры

`stats.usage` читает [канонический usage ledger](usage.md), как CLI/control и расход субагентов.
Usage display-блоков не суммируется: native message identity и cumulative semantics обрабатывает
один reducer. Index/checkpoint и usage contributions публикуются атомарно в SQLite cache.

ccmux агент-агностичен: сессию может бэкать разный агентский CLI. Их форматы истории
**структурно разные**, поэтому чтение идёт через **адаптер на формат + единый контракт**
`TranscriptMessage` (Zod, `config/schema.ts`). Никакого union-парсера с if-ветками.

## Контракт

`TranscriptMessage`: `{ id, seq, createdAt, role, kind, text, title, toolName, toolCallId, status, rawType }`.
- `role`: user · assistant · tool · system · unknown
- `kind`: message · tool_call · tool_result · thinking · event · unknown

Это же сообщение переиспользуется как `lastMessage` в `list --json` («где остановилось»).

## Интерфейс provider (`src/agent/index.ts`)

```ts
interface AgentProvider {
  id: "claude" | "codex";
  buildArgv(...): string[];
  launchEnv(...): Record<string, string>;
  historyFile(session, m): string | null;
  parse(lines, startLine, textLimit?): TranscriptMessage[];
  usedTokens(lines): number | null;
  lastModel(lines): string | null;
  scanPane(paneText): PaneScan;
}
```
Выбор provider — по `Session.agent` (`getProvider`/`providerFor`). IO + tail/cursor-окно живут в
`src/agent/transcriptRead.ts` (`readTranscriptFile`); managed lookup и previews остаются в
`src/agent/index.ts` (`readTranscript` / `lastTranscriptMessage` / `sessionUsedTokens`). Format
adapters остаются чистыми трансформами. `detect(lines)` — сниффер формата по содержимому для
неизвестного исторического файла.

## Exact external selection

`ccmux transcript 'external:<provider>:<machine>#<UUID>' --json` принимает точный key
из inventory для Codex и Claude. Встроенная machine выбирает existing fleet transport,
provider выбирает штатный parser. Это storage selector, не managed session alias и не
новый write address. Remote hop сохраняет key целиком; cwd/path не принимаются от caller.

`ccmux transcript app/<UUID> --json --tail 3` и форма с префиксом машины
`<machine>:app/<UUID>` читают persisted Codex JSONL без adopt, fork, запуска provider или записи
managed registry. Имя задачи и cwd не участвуют в lookup. Как и явный CLI `external`, чтение
не требует включения автоматического fleet scanning через `externalInventory`. Доступ задаётся
host account и разрешённым remote CLI transport; managed UUID требует managed address.
Service API `external.history` сохраняет собственный access policy и не расширяется этой командой.

`src/external/storage.ts` владеет общим с external-content lookup: configured root,
не более 8192 entries и восьми уровней, exact UUID filename и совпадающая metadata identity.
Codex проверяет первую `session_meta`; Claude — bounded metadata с `sessionId`.
Claude registry UUID и native continuation ID исключены из external read одинаково.
Требуются same-user regular file и отсутствие group/world write; symlink не обходится.
`src/external/transcript.ts` подключает подтверждённый файл к общему line reader.

Tail и backward limit ограничены 1000 строками. `seq` и `--cursor` — абсолютные номера
завершённых JSONL-строк; `--before LINE --limit N` читает предыдущее окно. Незавершённая последняя
строка появится только после newline. Первый запрос индексирует файл потоково, последующие
индексируют append; forward cursor сохраняет существующее значение «всё после LINE».
`--last-message` возвращает последний assistant text из bounded окна; external `--image`
явно не поддерживается. Это полный transcript projection, не authored-text external.history API
с его отдельным revision-pinned byte cursor.

Роль `user` означает native роль записи, а не криптографическое доказательство, что
текст напечатал человек: caller проверяет происхождение разрешения отдельно. Отсутствующая
native отметка времени остаётся null; время чтения не подставляется вместо неё.

Stored transcript: `source.available=true`, `kind=codex-jsonl|claude-jsonl`, exit 0; пустое успешно прочитанное
окно остаётся доступным. Missing: `source.available=false`, error `transcript file not found`.
Unreadable, invalid metadata, ambiguous identity или смена файла: false и `transcript file unreadable`.
В обоих отказах JSON содержит пустые messages и null cursor, exit 1; неизвестные cwd/path — пустые
строки. Неверный UUID и managed identity дают явный CLI refusal. Для external `session.rc`
содержит переданный inventory key либо exact `<machine>:app/<UUID>`; managed RC labels не меняются.
Неподдержанный provider возвращает `external transcript provider is unsupported`, exit 1.

## Нативные рантаймы без файла транскрипта

Часть нативных рантаймов не пишет jsonl: openCode и custom хранят переписку в собственной
структурированной истории. Для них `ccmux transcript` и control `transcript.read` отвечают из
того же feed, что и `history.read`, а не ищут несуществующий файл. Признак ветки — источник, а не
режим: `providerFor(session).historyFile(session, m) === null`. Это НЕ `hasNativeRuntime`:
codex app-server нативен, но его rollout-файл настоящий, и уводить его на feed значило бы
обменять рабочий транскрипт на частичный.

Окно собирает `src/context/transcriptWindow.ts`. Рантайм листает историю назад (первая страница —
самые новые записи, курсор ведёт к более старым), поэтому читатель забирает страницы до
`completeness: complete` и разворачивает их порядок: получается вся переписка по возрастанию.
Над ней применяется та же арифметика `tail`/`cursor`/`before`/`limit`, что и над строками файла,
и `seq` — абсолютный номер записи, так что курсор потребителя сохраняет смысл. `mtimeMs` равен
`null` (у feed нет времени файла), `source.kind` — `<agent>-native`.
`src/context/nativeTranscriptHistory.ts` принимает только полную цепочку: без пропущенных
entries, повторных item IDs/cursors, смены native identity/revision и противоречивых границ.
Без начала беседы абсолютная нумерация невозможна: неполный суффикс не получает seq/cursor.
Чтение ограничено общим deadline 5 секунд, 65 536 entries и 32 MiB сериализованных entries.
Превышение бюджета, `unknown` или неполная цепочка дают `source.available=false`, не успешное
пустое окно. Внешняя отмена действует и при ожидании mailbox-lock. При большой истории,
не помещающейся в эти бюджеты, для постраничного чтения предназначен `history.read`.

OpenCode native pagination (`src/context/opencodeHistory.ts`) ограничивает число **parts**, а
не только сообщений. Страница возвращает новейшие parts; cursor сохраняет opaque upstream
cursor и пары native message/part IDs для оставшегося префикса. Продолжение читает эти ID через
тот же authenticated SDK, не перечитывает изменившуюся голову списка и не хранит копии текста.
Чтение оставшегося суффикса имеет concurrency не выше восьми. Удалённый anchor отвергается;
generation/revision проверяет общий history cursor. Текстовые и image-бюджеты feed сохраняются:
полнота последовательности entries не означает неограниченный объём текста каждой записи.

Claude в нативном режиме остаётся файловым: рантайм пишет собственный jsonl рядом со своими
`projects`, и его читает тот же claude-парсер по `nativeTranscriptPath`, с абсолютными строками.
Он не проходит через feed. Неподдержанный `--agent` (субагент) для не-Claude нативного рантайма
даёт `unavailable` со словами «this runtime keeps no agent transcripts»; у Claude нативного
субагентский файл лежит рядом с основным и читается тем же путём.

Отсутствие живого владельца — это «не знаю», а не «пусто»: если feed недоступен, ответ
`available: false` с названной причиной, а не пустая успешная лента.

## Форматы (выверено на реальных файлах)

| | Claude Code | Codex |
|---|---|---|
| Файл | `~/.claude/projects/<enc-cwd>/<uuid>.jsonl` | `~/.codex/sessions/Y/M/D/rollout-*-<id>.jsonl` |
| Обёртка | `.type` = роль; `.message.content[]` | `.type=response_item`; `.payload` |
| text | `{type:text\|thinking, …}` | `{type:input_text\|output_text}` |
| tool call | inline `{type:tool_use, name, id, input}` | top-level `{function_call, name, arguments(JSON-строка), call_id}` |
| tool result | user `{type:tool_result, tool_use_id, content}` | `{function_call_output, call_id, output}` |
| reasoning | `{type:thinking, thinking}` (текст есть) | `{reasoning, encrypted_content, summary[]}` → текст сводки, при `summary: []` — `text: null` |
| токены | `.message.usage` | отдельный `event_msg/token_count → info.*_token_usage` |
| роли | user/assistant | user/assistant/**developer**(→system) |

Отсутствие сводки — признак в данных, а не строка. У зашифрованного размышления `text` равен `null`
при `rawType: 'reasoning'`; заглушки в тексте нет. Строка-заглушка заставляла бы потребителя узнавать
её сверкой по тексту, и эта сверка неверна в обе стороны: настоящая сводка, случайно так
написанная, была бы проглочена, а смена формулировки у нас молча превратила бы все заглушки в
содержимое. Поток содержимого control-service тем же правилом живёт с самого начала — он публикует
`reasoning-summary` только когда сводка есть.

## Субагенты Claude и время конца вызова

Claude Code запускает субагентов инструментом `Agent`. В файле сессии это выглядит так: `tool_use`
с `subagent_type`/`description`/`prompt`, через доли секунды `tool_result` «Async agent launched
successfully» — а на самой записи результата, в `toolUseResult`, лежит `agentId`, `status:
async_launched`, `resolvedModel`. Субагент пишет свой транскрипт в
`<uuid>/subagents/agent-<id>.jsonl` рядом с файлом сессии (плюс `agent-<id>.meta.json`), а закончив,
рантайм вставляет в основную ленту `user`-сообщение `<task-notification>` с `<tool-use-id>`,
`<status>` и `<result>` — итоговым текстом субагента.

Адаптер (`src/agent/claude/transcript.ts`, `src/agent/claude/subagent.ts`) делает из этого одну
запись:

- у вызова `Agent` есть `agent`: id, тип, описание, модель, `state` (`running` | `finished`),
  начало и конец, число вызовов инструментов и суммарный расход из файла субагента, `available`
  (файл был на месте). Расход считается по одному разу на API-сообщение: блоки одного ответа делят
  `message.id`, и без этого двухблочный ответ стоил бы вдвое;
- асинхронный вызов остаётся `done: false`, пока субагент работает. Конец решают два свидетеля, в
  порядке силы: уведомление в окне (называет вызов и статус) либо файл субагента, кончающийся его
  собственным текстом без вызова после (`idle`). Квитанция о запуске сама по себе конца не
  доказывает. `result` — «N tool calls», `resultText` — отчёт субагента;
- уведомление сохраняет вид `message`/`user`, но получает `title: task-notification` и
  `toolCallId` своего вызова — связь читается из полного текста ДО клипа, поэтому обрезка длинного
  отчёта её не рвёт;
- у каждого свёрнутого вызова (Claude и Codex) есть `doneAt` — время записи его `tool_result`.
  Без этого потребитель, считающий хронологию, знал начало вызова и не знал конца.

Файл субагента читается тем же парсером: `ccmux transcript <session> --agent <id>` и
`transcript.read { agent }` подставляют `subagents/agent-<id>.jsonl` вместо файла сессии; для
Codex ответ — `unavailable` со словами «this runtime keeps no agent transcripts». Факты субагента
кэшируются по mtime (`MtimeCache`): законченный файл больше не меняется, а спрашивают его на каждом
окне, содержащем вызов.

`--text-limit CHARS` (контроль: `textLimit` до 65 536) поднимает предел текста записи: клип по
умолчанию (6000) размечен под листинг, а не под отчёт, и потребителю, разбирающему уведомление или
показывающему длинный ответ целиком, нужен текст без обрыва.

## Чтение untyped-границы без `as`

Raw JSONL — внешняя нетипизированная граница (формат принадлежит агенту). Читается
через type-guards в `normalize.ts` (`isRecord`/`str`/`rec`/`num`/`flattenContent`) — это
разрешённое исключение «изолированный адаптер над untyped external», ноль `as`/кастов.

## Добавить новый агент

1. `src/agent/<agent>/` — реализовать `AgentProvider`.
2. Зарегистрировать provider в `src/agent/index.ts`.
3. Добавить значение в `AgentKindSchema` (`config/schema.ts`).
Ядро (`list`, `transcript`, TUI) не меняется — оно работает с контрактом.

## Codex lifecycle boundary

Codex provider реализует transactional first-rollout binding, resume, transcript, tokens и model
parsing. Pending generation живёт отдельно от ready Session и привязывается по exact persisted
launch marker; cwd/mtime никогда не выбирают rollout. Production boundary остаётся обычным
per-session Codex TUI под tmux; внешний App
Server не становится вторым driver или transcript source. Решение и probes:
`docs/decisions/2026-08-10-codex-process-tui-driver.md`.
