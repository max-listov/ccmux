---
title: Tests that fail only inside the full suite, and only under load
description: Two timing assertions pass alone and fail intermittently in the full run on a busy machine, which makes a green suite a coin flip rather than a signal.
type: task
status: done
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01 15:28 +0700
priority: P2
---

## Problem and evidence

`test/control-model-bootstrap.test.ts` → "cancelled host read reaps its metadata process without
creating a writer" fails inside `bun run check` and passes on its own. Observed three times on
2026-09-01, each ~470 ms into the case; two isolated runs and one clean full run immediately after
were green.

`test/codex-owned-reader.test.ts` → "released ESM reader works offline, coalesces 100 callers and
never starts CLI/RPC processes" is the same shape: it failed once inside `bun run check` on
2026-09-01 with `status: unavailable, reason: deadline`, and passed five out of five isolated runs
immediately after. It coalesces a hundred concurrent readers against a fixed deadline.

The machine carries fifteen live agent sessions, so the suite competes for CPU with real work. Both
cases assert on timing while controlling nothing about the scheduler — one reaps a spawned process,
the other holds a deadline across a hundred callers.

What makes it worth fixing rather than tolerating: a suite that fails at random teaches its reader to
re-run instead of to look, and the next real regression will arrive dressed as this one. It has
already cost three investigations.

## Result

- The case asserts the reap by an observable fact rather than by winning a race — the process is
  gone, or its exit was recorded, without depending on how quickly the host got round to it.
- A green suite means the same thing every time it is green.

## Boundaries

Not a timeout increase. A longer deadline makes the flake rarer and the signal no better; the point
is to remove the dependency on timing, or to state the timing bound the code actually guarantees and
assert that.

## Что сделано

Обе проверки утверждали о скорости планировщика, хотя ни одна из них про скорость не была.

- [x] `test/control-model-bootstrap.test.ts` — ожидание наблюдаемого состояния вместо одного взгляда
      после паузы. Зубы сохранены: ребёнок, которого не пожали, по-прежнему валит проверку и говорит
      это своим pid'ом, а не таймаутом, который нечем прочитать.
- [x] `test/codex-owned-reader.test.ts` — шаг про коалесинг падал с `deadline`, когда машина занята.
      Поднять лимит нельзя: `timeoutMs` у самого reader'а ограничен секундой по контракту
      (`src/agent/codex/ownedRead.ts`), и это правильный предел для резидентного чтения. Поэтому
      исправлено утверждение: `deadline` — законный ответ этого reader'а, и партия читателей берётся
      заново, а не засчитывается как дефект. Счётчик открытий меряется **на партию**, поэтому повтор
      не может скрыть reader, переставший коалесить; всё остальное по-прежнему валит проверку; а сам
      дедлайн доказывается отдельным шагом на 2 мс против чтения, замедленного до 20.
- [x] Прогнано по три раза каждая — зелено.

## Acceptance

- [x] Ни одна проверка больше не утверждает о скорости машины.
- [x] Полный гейт зелёный.
