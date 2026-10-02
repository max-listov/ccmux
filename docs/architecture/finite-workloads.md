---
title: Допуск конечных workloads
description: Контракт установленного launcher для decoder вложений и custom commands.
status: active
created: 2026-10-02 13:39 +07:00
updated: 2026-10-02 13:39 +07:00
participants:
  - role: authored
    harness: Codex Desktop
    model: GPT-6
    at: 2026-10-02 13:39 +07:00
type: architecture
---

CCMux подключает конечные процессы к установленному `node-workload-run`. Launcher
владеет admission, node budget и очисткой дерева; CCMux не реализует второй resource
registry. В machine config подключение задаётся опциональным полем:

```json
{
  "finiteWorkloads": {
    "launcherBin": "/usr/local/bin/node-workload-run",
    "profileFile": "/etc/workload/profile.json"
  }
}
```

Оба пути абсолютные. Numeric ceilings и reserves принадлежат node profile, а не
настройке consumer. Без поля остаются прежние прямые запуски без этой resource protection.
При заданном поле недоступный launcher, неподдерживаемая платформа, отказ допуска
или ошибка протокола завершают операцию с причиной; bypass на прямой spawn отсутствует.
Конфигурацию включают после квалификации host policy. Установка обновления сама её не включает.

## Поток исполнения

`src/runtime/finiteWorkload.ts` создаёт собственный temporary directory0700 и request0600,
затем запускает executable без shell с `--request` / `--result`. Запрос
`node-workload-request/v1` содержит payload argv, cwd, declared-only environment,
profile, deadline и IO bounds. Binary stdin/stdout отделены от structured outcome.

`node-workload-result/v1` различает completed, refused и failed. Consumer проверяет
outcome и соответствие launcher exit. Payload exit125 остаётся completed; один exit125
не доказывает admission refusal. Missing/malformed outcome даёт точную внутреннюю ошибку.
CCMux удаляет только свой request directory после завершения launcher и не стирает
admission registry или SDK manifests.

Отмена custom command запрашивает SIGKILL у adapter; adapter отправляет launcher
SIGTERM, чтобы дождаться очистки дерева. Tool close/settlement выдаётся после launcher
cleanup. Уничтожение вызывающего процесса покрывается installed guard по process-instance
identity; consumer самостоятельно этот механизм не воспроизводит.

## Подключённые пути

Attachment decoder передаёт binary input и сохраняет обычный результат image validation.
Abort ждёт settlement. Ошибка допуска сохраняет внутренний cause, наружу проходит
контракт AttachmentFault.

Custom `run_command` подключён через опубликованный `AgentProcessSandbox.spawn`.
Probe допускает только process-contained capability на поддерживаемом Linux launcher.
Это partial sandbox: network, secrets и workspace write isolation не заявлены.
Temporary scratch относится к указанному request directory; лимит не является hard quota
для произвольных файлов в tool cwd. Deadline30s и output32768 bytes сохраняют текущие
границы custom command.

## Границы

Native provider servers, custom harness, resident MCP, tmux и daemon не помещаются в
finite slot. Resource protection resident trees требует отдельного поддержанного
контракта и policy. External writers также не становятся managed по одному ancestry.
Darwin launcher для этого finite контракта unsupported: configured execution отказывает
явно; отсутствие configuration не выдаётся за включённую защиту.

Isolated qualification проверяет actual decoder/custom handler, concurrent refusal,
отмену surviving child, падение caller и следующий допуск. Проверка live daemon restart,
истории и profile migration относится к rollout после разрешённой activation.
