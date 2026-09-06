---
title: Транскрипт-адаптеры (мульти-агент)
description: Как ccmux читает историю сессии разных агентских CLI (Claude Code, Codex) через единый контракт
type: architecture
status: active
created: 2026-06-09
updated: 2026-09-06 18:17 +0700
---

# Транскрипт-адаптеры

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

## Exact external Codex address

`ccmux transcript app/<UUID> --json --tail 3` и форма с префиксом машины
`<machine>:app/<UUID>` читают persisted Codex JSONL без adopt, fork, запуска provider или записи
managed registry. Имя задачи и cwd не участвуют в lookup. Как и явный CLI `external`, чтение
не требует включения автоматического fleet scanning через `externalInventory`. Доступ задаётся
host account и разрешённым remote CLI transport; managed UUID требует managed address.
Service API `external.history` сохраняет собственный access policy и не расширяется этой командой.

`src/external/storage.ts` владеет общим с external-content lookup: configured root,
не более 8192 entries и восьми уровней, exact UUID filename и совпадающая первая metadata record.
Требуются same-user regular file и отсутствие group/world write; symlink не обходится.
`src/external/transcript.ts` подключает подтверждённый файл к общему line reader.

Tail и backward limit ограничены 1000 строками. `seq` и `--cursor` — абсолютные номера
завершённых JSONL-строк; `--before LINE --limit N` читает предыдущее окно. Незавершённая последняя
строка появится только после newline. Первый запрос индексирует файл потоково, последующие
индексируют append; forward cursor сохраняет существующее значение «всё после LINE».
`--last-message` возвращает последний assistant text из bounded окна; external `--image`
явно не поддерживается. Это полный transcript projection, не authored-text external.history API
с его отдельным revision-pinned byte cursor.

Stored transcript: `source.available=true`, `kind=codex-jsonl`, exit 0; пустое успешно прочитанное
окно остаётся доступным. Missing: `source.available=false`, error `transcript file not found`.
Unreadable, invalid metadata, ambiguous identity или смена файла: false и `transcript file unreadable`.
В обоих отказах JSON содержит пустые messages и null cursor, exit 1; неизвестные cwd/path — пустые
строки. Неверный UUID и managed identity дают явный CLI refusal. Для external `session.rc`
содержит exact `<machine>:app/<UUID>`; managed RC labels не меняются.

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
