---
title: Codex остаётся per-session process TUI provider
description: ccmux сохраняет обычный Codex TUI как production driver; внешний App Server остаётся versioned research boundary до production support
type: decision
status: active
created: 2026-08-10
updated: 2026-08-10
tags: [codex, app-server, tui, ownership, persistence]
---

# Codex остаётся per-session process TUI provider

## Контекст

Codex CLI `0.147.0` содержит публичный App Server protocol, remote TUI и persistent thread store.
При этом обычный Codex TUI уже использует App Server **in-process**: вопрос не в том, использовать ли
эти внутренние primitives, а в том, должен ли ccmux заменить один интерактивный CLI-процесс на
внешний App Server с отдельным remote TUI и control client.

Официальная документация описывает App Server как JSON-RPC integration surface. CLI помечает
команду `app-server`, `--remote` и `remote-control` experimental; документация отдельно называет
WebSocket transport experimental и production-unsupported. Stdio/unix и stable methods
документированы, но end-to-end remote TUI runtime не имеет доказанной production maturity.
Generated stable schema — surface с отфильтрованными experimental methods/fields; experimental
runtime calls дополнительно требуют `initialize.capabilities.experimentalApi`. Ни одно из этих
понятий само по себе не является production guarantee.

## Факты версии 0.147.0

- Обычный TUI запускает `InProcessAppServerClient`; remote TUI подключает
  `RemoteAppServerClient`. Это один protocol с разной process boundary.
- `thread/list` без `sourceKinds` возвращает только interactive origins (`cli`, `vscode`). Source
  описывает происхождение thread, но не provider ccmux, не владельца writer и не адрес получателя.
- `thread.status` и `thread/loaded/list` отражают память конкретного App Server. `notLoaded` не
  означает, что внешний writer отсутствует.
- Writer защищён cross-process file lock. Изолированный probe подтвердил: второй App Server видит
  persisted thread как `notLoaded`, но `thread/resume` получает `already has an active writer`;
  после завершения владельца тот же UUID успешно resume.
- До первого turn `thread/start` уже создаёт live runtime identity, но rollout ещё не существует:
  другой процесс получает `no rollout found`. Значит registry reconciliation нельзя строить только
  на немедленном поиске JSONL.
- Version-matched schema обязательна. Например, web-пример использует camel-case sandbox value,
  тогда как binary `0.147.0` принимает CLI-style `read-only | workspace-write |
  danger-full-access`.
- Desktop task tools не являются свойством standalone App Server. Built-in methods,
  config-backed MCP/plugins, experimental client dynamic tools и Desktop-host injected tools —
  разные capability sources.

Воспроизводимый probe: `bun scripts/codex-app-server-probe.ts`. Он использует временный
`CODEX_HOME`/workspace, копирует только auth во временную директорию, делает один синтетический turn
без tools и полностью удаляет временный state.

## Решение

Production driver остаётся **одним обычным Codex TUI process на одну managed ccmux session** под
tmux. ccmux не запускает shared/per-session external App Server, не подключает второй mutating
protocol client и не использует внутренний Desktop control socket.

Источники правды разделены так:

| Сущность | Источник правды |
|---|---|
| ccmux identity | registry record: `agent + machine + session name` |
| Codex thread identity | однозначно reconciled Codex UUID в registry; placeholder до reconcile не является identity |
| Беседа, модель, токены, activity | persisted Codex rollout JSONL через provider adapter |
| Live TUI state | pane scanner конкретного managed process |
| Writer ownership | atomic admission при фактическом `thread/resume`; discovery — только advisory |
| Runtime source (`cli`, `vscode`, `appServer`) | origin metadata, не routing key и не ownership proof |

Process TUI сохраняет per-session environment (`CCMUX_SESSION`), flags, cwd, root guard,
management prompt, subscription auth, slash commands и существующий daemon→tmux self-heal без
нового failure domain.

Успешный `thread/resume` самим будущим managed Codex process — единственный authoritative
ownership transition: cross-process lock делает его атомарным. Любой отдельный read-only precheck
имеет TOCTOU и не разрешает takeover. Conflict означает rollback pending pane/registry change без
повторной попытки и без полузарегистрированной session; после остановки владельца takeover всё равно
завершается тем же atomic resume.

Текущий first-launch reconciler выбирает newest rollout по cwd/mtime и поэтому не различает два
одновременных старта в одном cwd. Это открытая lifecycle boundary: cwd/mtime запрещены как identity,
а placeholder UUID не становится authoritative до provider-correlated reconciliation.

## Отклонённые варианты

### Один внешний App Server на машину

Отклонён: общий failure domain и Code Mode host, а process-level env не доказывает отдельную
`CCMUX_SESSION` identity для каждого thread. Один restart затрагивает весь Codex-флот машины.

### Один внешний App Server на session + remote TUI

Отклонён сейчас: сохраняет изоляцию, но добавляет sidecar/process supervision и reconnect protocol
на production-unsupported boundary без необходимой ccmux функции, которой нет у обычного TUI.

### Hybrid: обычный TUI writer + внешний mutating client

Отклонён: два mutation-capable владельца нарушают single-writer invariant. ccmux read-only observer
не должен вызывать `thread/resume`, `turn/start`, `turn/steer` или `thread/inject_items`.

## Последствия

- Codex chat по-прежнему требует доказанный TUI detector; App Server не используется как shortcut
  вокруг partial input, approval/menu и human composer.
- External discovery может читать persisted metadata, но `notLoaded`, mtime и source никогда не
  разрешают takeover. Оно advisory; ownership доказывает только atomic resume будущего managed
  process, а до его успеха registry не меняется.
- App Server остаётся future boundary. Решение пересматривается, когда OpenAI объявит внешний
  runtime production-supported и versioned probes докажут remote TUI parity, per-thread identity,
  reconnect semantics и один writer.
- Официальный contract: [Codex App Server](https://learn.chatgpt.com/docs/app-server). Source для
  сверки версии: `openai/codex`, `codex-rs/app-server*`, `thread-store` и `tui`.
