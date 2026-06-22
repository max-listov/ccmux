---
title: Демон должен переживать чужой SIGTERM (и смерть демона не должна быть тихой)
description: Случайный SIGTERM (pkill соседа) убивает демона навсегда — graceful exit 0 + KeepAlive SuccessfulExit=false читается launchd/systemd как «остановили намеренно»; флот остаётся без самохила молча
type: task
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11 10:58 +08:00
---

## Инцидент (2026-06-11)

Агент в одной из сессий рестартил СВОЙ dev-бэкенд командой `pkill -x bun -f`
(без скоупа — матчит ВСЕ bun-процессы машины, проверено pgrep). Итог:

- **10:17:35** демон ccmux (bun) поймал SIGTERM → вежливый shutdown → **exit 0**.
- launchd `KeepAlive: SuccessfulExit=false`: exit 0 = «остановлен намеренно» → **не поднял**.
- **10:17:36** `_run` cc-main (bun) убит → tmux-сессия cc-main умерла.
- Хилить некому (хилит демон, демон мёртв) → cc-main пролежал мёртвым ~полдня,
  заметили случайно. Обёртка самого убийцы уцелела (pkill не убивает своих предков).

На Linux дыра та же: systemd `Restart=on-failure` + clean exit на SIGTERM.

## Корень

Графсфул-обработчик SIGTERM конвертирует ЛЮБОЙ внешний терм в «успешный» выход.
Дизайн-намерение (`ccmux uninstall`/stop = лежать тихо) распространилось на враждебный
случай. Парити-аудит пометил это «корректнее bash» — кейс показал обратную сторону.

## Варианты фикса (решить при проработке)

1. **Exit-код по источнику**: на SIGTERM выходить НЕнулевым, если нет явного стоп-маркера
   (файл-флаг, который пишет `uninstall`/`update` перед остановкой) → launchd/systemd
   поднимают после чужого SIGTERM, уважают намеренный стоп.
2. KeepAlive=true / Restart=always + явный `launchctl bootout`/`systemctl stop` для
   намеренной остановки (как делал bash; но тогда `update` bounce переписать на restart).
3. (доп.) Watchdog-сигнал: демон умер → следующий `ccmux list`/TUI замечает и громко
   предупреждает (TUI и так показывает stopped, но никто не смотрит — push?).

## Решение (реализовано 2026-06-11)

Выбран упрощённый вариант 1 — **стоп-маркер НЕ нужен**: проверка кода показала, что ВСЕ
намеренные остановки не зависят от exit-кода демона:
- `uninstall` → `launchctl bootout` / `systemctl disable --now` (джоб выгружен / ручной
  стоп — не перезапускается при любом коде);
- `update`/`restart` bounce → `kickstart -k` / `systemctl restart` (перезапуск гарантирован).

Фикс: `signalExitCode()` в `src/commands/daemon.ts` — SIGTERM→143, SIGINT→130 (128+signum);
обработчик выходит этим кодом → `KeepAlive SuccessfulExit=false` (launchd) и
`Restart=on-failure` (systemd) поднимают демона после чужого сигнала. Exit 0 остался
только за invalid-config («лежать тихо громко-один-раз»). Тест: `test/daemon.test.ts`.

⚠️ Live e2e (`kill <pid>` → демон сам встал) — только после деплоя бандла с фиксом
(прод-демон пока на v0.0.7 со старым поведением).

## Acceptance

- [x] `kill <daemon-pid>` (SIGTERM) → демон поднимается сам — **проверено live на dev 2026-06-11**: launchd — одноразовый плист (`com.ccmux.daemon.sigterm-test`, KeepAlive SuccessfulExit=false) + дев-демон с изолированным `CCMUX_CONFIG`: kill → `last exit code = 143` → воскрес новым PID (~10с, launchd-троттлинг); systemd — transient-юнит на dev-сервере (`Restart=on-failure`, trap exit 143): kill → новый PID, `NRestarts=1`. Реальный серверный юнит прогонится ещё раз при роллауте.
- [x] Намеренный стоп НЕ поднимается — проверено: `launchctl bootout` тест-лейбла → лежит (джоб выгружен); `systemctl stop` transient-юнита → лежит.
- [x] `ccmux update` bounce работает как раньше — `kickstart -k`/`systemctl restart` перезапускают независимо от exit-кода (код не менялся; kickstart прогнан сегодня же при подъёме демона).
- [x] Тест на exit-код — `test/daemon.test.ts` (`signalExitCode`: SIGTERM→143, SIGINT→130); стоп-маркер отклонён: не нужен, все намеренные пути exit-code-agnostic (см. «Решение»).

## Что сделано

- [x] **Код**: `signalExitCode()` + ненулевой выход на сигнал — `src/commands/daemon.ts` (installSignals); exit 0 остался только за invalid-config.
- [x] **Тест**: `test/daemon.test.ts` (54/54 зелёные, typecheck чистый).
- [x] **Live e2e на dev (прод не тронут)**: изолированная песочница `CCMUX_CONFIG`+пустой реестр; launchd-плист с боевым KeepAlive-блоком; transient systemd-юнит на dev-сервере. Все 4 сценария ✅ (см. Acceptance).
- [x] **Что НЕ делалось**: вариант 2 (KeepAlive=true) и вариант 3 (watchdog/push при мёртвом демоне) — отклонены/не потребовались; push-нотификация «демон лежал N минут» может вернуться идеей в live-клиенте.
- [x] **Деплой**: фикс уедет в прод со следующей версией (гейт владельца); до того прод-демон уязвим к чужому SIGTERM — известно и принято.
