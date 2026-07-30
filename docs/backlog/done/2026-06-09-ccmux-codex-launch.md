---
title: ccmux — Codex launch/resume (закрыть launch-гэп)
description: Запуск/резюм для agent=codex — id-pin, resume по нашему uuid, RC-имя, инъекция управляющего промпта
type: task
status: done
created: 2026-06-09
updated: 2026-07-30
completed: 2026-07-30 08:40 +07:00
related: docs/backlog/done/2026-06-09-ccmux-bun-port.md
---

## Контекст
ЧТЕНИЕ Codex (transcript/pane/locate) уже 1:1 через провайдер. Открыт только LAUNCH:
- Codex на новой сессии генерит СВОЙ id (не наш uuid) → `resume.ts` не находит первый rollout
- нет `--append-system-prompt` → инъекция управляющего промпта и RC (`-n` эквивалент) не заведены

## План
- [x] Runtime-спайк (codex-cli 0.144.6): `codex resume <SESSION_ID|name> [PROMPT]` резюмит по UUID
  (UUID имеет приоритет); `--session-id` при создании **нет** → Codex генерит свой id. Решение —
  **id-reconcile** через тот же follow-fork конвейер, что у Claude (`ensure.ts`→`forkedUuid`→`detectFork`).
- [x] RC-имя для Codex — **нет** аналога `-n` (RC = claude.ai, у Codex нет) → RC остаётся Claude-only, задокументировано.
- [x] Инъекция управляющего промпта — через **leading positional PROMPT** на первом старте (у Codex нет
  `--append-system-prompt`); на resume НЕ инжектим (иначе новый turn на каждый heal).
- [x] e2e — reconcile проверен на РЕАЛЬНОМ выводе codex (см. «Что сделано»); полный демон-в-tmux цикл на живом флоте не гоняли (риск).

## Acceptance
- [x] `agent=codex` запускается (prompt-инъекция) / reconcile id / резюмится по uuid — 1:1 с Claude,
  насколько Codex CLI позволяет (без RC — его у Codex нет).

## Что сделано

- [x] **`src/agent/codex/launch.ts`** — `buildArgv`: первый старт `codex [flags] "<prompt>"` (инъекция
  `buildPrompt`), resume `codex resume <uuid> [flags]` без промпта; root-guard стрипает
  `--dangerously-bypass-*` под root-демоном.
- [x] **`src/agent/codex/fork.ts`** (новый) — `detectFork`: reconcile self-assigned id из свежего
  rollout'а по cwd; short-circuit после reconcile (стабильная сессия не сканирует). Встроен в
  существующий `ensure.ts`→`forkedUuid` конвейер (регистрация в `codex/index.ts`).
- [x] **`resume.ts`** — комментарий про gap обновлён (закрыт).
- [x] **`test/codex-launch.test.ts`** — buildArgv (first/resume/flags), detectFork (reconcile/cwd-guard/
  taken-guard/short-circuit).
- [x] **Реальный e2e reconcile** — прогнал `detectFork` против живой `~/.codex/sessions`: placeholder→null,
  выцепил настоящий id `019f7d5b-…`, после reconcile `historyFile` нашёл rollout, повторный `detectFork`→null.
  Формат rollout (имя+`session_meta.cwd`) сверен с реальным выводом codex.

## Что НЕ делалось / известные грани

- **Полный демон-в-tmux цикл** (`ccmux new --agent codex` → heal → reconcile → resume → send на живом
  флоте) НЕ прогонялся — риск для боевых сессий; компоненты валидированы по отдельности + reconcile на
  реальных данных. Первый живой codex под ccmux стоит завести под наблюдением.
- **RC для Codex** — нет (у Codex нет claude.ai Remote Control). Осознанно.
- **Грань reconcile:** две codex-сессии, стартующие в ОДНОМ cwd в пределах одного тика, могут гонку на
  «newest»; `takenUuids` не даёт перехватить чужой id. При нужде — усилить меткой (инжектируемый промпт
  несёт имя сессии, оно пишется в rollout).
- codex-cli на аккаунте ChatGPT отверг дефолт-модель `gpt-5.6-sol` (400) — это конфиг модели, не наш код.
