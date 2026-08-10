---
title: Транскрипт-адаптеры (мульти-агент)
description: Как ccmux читает историю сессии разных агентских CLI (Claude Code, Codex) через единый контракт
type: architecture
status: active
created: 2026-06-09
updated: 2026-08-10
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
`src/agent/index.ts` (`readTranscript` / `lastTranscriptMessage` / `sessionUsedTokens`); format
adapters остаются чистыми трансформами. `detect(lines)` — сниффер формата по содержимому для
неизвестного исторического файла.

## Форматы (выверено на реальных файлах)

| | Claude Code | Codex |
|---|---|---|
| Файл | `~/.claude/projects/<enc-cwd>/<uuid>.jsonl` | `~/.codex/sessions/Y/M/D/rollout-*-<id>.jsonl` |
| Обёртка | `.type` = роль; `.message.content[]` | `.type=response_item`; `.payload` |
| text | `{type:text\|thinking, …}` | `{type:input_text\|output_text}` |
| tool call | inline `{type:tool_use, name, id, input}` | top-level `{function_call, name, arguments(JSON-строка), call_id}` |
| tool result | user `{type:tool_result, tool_use_id, content}` | `{function_call_output, call_id, output}` |
| reasoning | `{type:thinking, thinking}` (текст есть) | `{reasoning, encrypted_content}` → текст `[reasoning]` |
| токены | `.message.usage` | отдельный `event_msg/token_count → info.*_token_usage` |
| роли | user/assistant | user/assistant/**developer**(→system) |

## Чтение untyped-границы без `as`

Raw JSONL — внешняя нетипизированная граница (формат принадлежит агенту). Читается
через type-guards в `normalize.ts` (`isRecord`/`str`/`rec`/`num`/`asText`) — это
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
