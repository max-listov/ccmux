---
title: ccmux как драйвер сессий (stream-json / Agent SDK)
description: Хостить claude-процессы самим (как desktop app) вместо скрейпа tmux-пейна — живые статусы из событий, честный compose, путь к live web/mobile клиенту
type: task
status: icebox
created: 2026-06-10
updated: 2026-06-11
defrost: после 2026-06-15 — прояснился биллинг Agent SDK (слетает ли голый `claude -p --input-format stream-json` с Max-подписки; см. docs/research/2026-06-10-acp.md)
---

# ccmux как драйвер сессий (stream-json)

## Идея
Сейчас ccmux — супервайзер интерактивного claude в tmux: статусы скрейпятся из пейна
(регэкспы по спиннеру), compose — через `send-keys`. Desktop app работает иначе: он сам
хостит процесс `claude --print --input-format stream-json --output-format stream-json
--resume <uuid>` и общается событиями.

Перевести ccmux (опционально, режим per-session) на ту же модель:

- **Статусы из реальных событий**, не из регэкспов по отрисовке: tool_use/tool_result/
  thinking/message приходят структурированными в stream-json. Класс багов
  «idle-while-working» исчезает по построению.
- **Честный compose**: инжект сообщения программно в наш же процесс, без send-keys-гонок.
- **Live-клиент**: на этих событиях строится web/mobile клиент (push, не poll) — стык
  с The Base / StitchKit направлением.

## Контекст (выяснено 2026-06-10)
- IPC в ЧУЖОЙ интерактивный claude не существует (Remote Control — human-only).
- `-p --resume` аппендит в jsonl, но живой инстанс чужих дописок не видит → форк.
- Поэтому «писать в сессию» честно можно только владея процессом — этот таск.
- Детекция живых писателей по ps уже есть (`src/agent/claude/writers.ts`).

## Открытые вопросы
- attach-UX: tmux-пейна нет — нужен наш транскрипт-рендер как основной вид (он уже есть в TUI).
- permission prompts в stream-json режиме (`--permission-prompt-tool stdio` — как у desktop).
- сосуществование двух режимов (tmux-сессии и driven-сессии) в одном реестре/списке.
- Agent SDK vs голый stream-json CLI — что стабильнее как контракт.
