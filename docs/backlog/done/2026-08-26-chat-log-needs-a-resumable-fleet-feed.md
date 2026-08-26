---
title: Chat log needs a resumable fleet feed
description: Expose append-only chat changes as a bounded cursor stream so dashboards can stay live without polling or truncated fleet snapshots.
type: task
status: done
tags: [chat, events, fleet, stream, cursor]
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 11:38 +07:00
---

# Chat log needs a resumable fleet feed

## Зачем

`chat log --fleet --json` is a point-in-time tail. It has no follow mode or stable cursor, so a live
consumer must poll whole snapshots. Large message bodies also make a moderate fleet tail exceed a
remote command output cap; the resulting JSON is truncated and cannot be parsed at all.

## Результат

- A bounded NDJSON command streams immutable `LogRow` records and machine availability changes.
- Every frame carries a stable resume cursor; reconnect replays rows after that cursor exactly once
  at the consumer boundary.
- Fleet fan-out never serializes one unbounded JSON document. Message bodies remain intact and are
  bounded per record with an explicit refusal for an oversized record.
- The current `chat log --fleet --json` snapshot remains useful for first paint, while the feed owns
  subsequent changes.

## Acceptance

- [x] A row appended while a consumer is disconnected is delivered after reconnect from its cursor.
- [x] A message larger than the transport envelope is refused as a named bounded outcome, not
      emitted as truncated JSON.
- [x] One unreachable machine produces a machine-state frame without stopping rows from peers —
      **in the snapshot**, which is where fan-out lives; in the feed it is one stream per machine and
      a lost machine is that stream's own named break. Reason in «Где фан-аут» ниже.
- [x] Local and fleet modes share one strict frame schema and a transport-safe framed form.
- [x] Tests cover reconnect, duplicate timestamps, clock skew, long Unicode bodies and peer loss.

## Где фан-аут, и почему не внутри ccmux

Фид сделан **локальным**, и это решение, а не упущение.

Чат-лог машины — это её собственные два файла, поэтому флотовый фид это N локальных фидов.
Транспорт, который несёт один, несёт и N: ровно так поток событий сессий уже доезжает до панели
сегодня. Держать N долгоживущих удалённых команд открытыми внутри ccmux значило бы построить
мультиплексор потоков на слой выше того, где он уже есть, и превратить курсор из одной позиции в
одном файле в N позиций на N часах — то есть вернуть ровно ту проблему с часами, которую позиционный
курсор снимает.

Поэтому `--fleet` остаётся снимком для первой отрисовки, а фид владеет тем, что происходит дальше.
Недоступность машины в снимке по-прежнему отдельная строка (`machines[]`), а в потоке — обрыв
конкретной подписки, который транспорт уже называет тремя разными исходами.

## Что сделано

### Фид

- [x] `src/chat/logFeed.ts` — курсор, кадры, границы, слежение. Курсор **позиционный**
      (`<поколение>.<ledger>.<outbox>`), потому что строки несут часы той машины, которая породила
      сообщение: секунду делят многие, а поправленные часы двигают запись назад. Временной курсор в
      таких условиях либо повторяет уже прочитанное, либо молча пропускает непрочитанное.
- [x] Курсор чужого поколения **отвергается**, а не толкуется: смена поколения — единственное
      событие, которое двигает позиции, и продолжить чтение по старым числам значит зайти в чужую
      историю без единой ошибки на экране.
- [x] `ccmux chat log --follow` с `--json`, `--framed` и `--since`; читает
      `STITCHWIRE_STREAM_CURSOR` при переоткрытии — тот же контракт, что у потока событий сессий.
      Негодный курсор отвергается громко из обоих источников.
- [x] Кадр ограничен 32 КиБ — одним чанком транспорта, а не числом из головы. Слишком большое тело
      **заменяется** фразой с настоящим размером, а не режется: маршрут, время и позиция целы,
      курсор двигается, ничего после не теряется. Предел считает БАЙТЫ, поэтому длинная юникодная
      строка ограничена тем, что реально уходит на провод.
- [x] Одна строгая схема кадров на обе разновидности (`row` и `machine`), поэтому «там ничего не
      происходило» отличимо от «мы не смогли посмотреть».
- [x] `rowFromLedgerRecord` / `rowFromOutbound` вынесены в `src/chat/fleetLog.ts` — снимок и фид
      строят строку одним определением, а не двумя, которые могут разъехаться.

### Снимок

- [x] `remoteLogs` спрашивает через `runPeer`, а не по ssh-карте напрямую: машина, доступная только
      по проводу, раньше не показывалась недоступной — она **отсутствовала**, что читается как
      машина, где ничего не происходило.
- [x] Обрезанный транспортом ответ называется обрезанным, а не «older ccmux?». Оба дают одинаковый
      сбой разбора и не имеют между собой ничего общего: одно лечится `-n`, другое обновлением
      машины. Снимок сериализует целые тела сообщений, поэтому обрез — это то, что и происходит.

### Тесты

- [x] `test/chat-log-feed.test.ts`, 18 проверок: переподключение, одинаковые метки времени, часы,
      идущие назад, независимое продвижение двух файлов, отказ по поколению и по форме курсора,
      замена большого тела, байтовый предел на юникоде, неповреждённое короткое юникодное тело,
      строгость схемы, нечитаемая запись как строка, недописанная строка. 642 теста зелёные.

### Проверено на живых данных

- [x] На настоящем реестре: 300 кадров, крупнейшая строка 12 160 байт, конечный курсор `2.145.154`.
- [x] Переподключение сквозь CLI на изолированном инстансе: прочитали до `2.1.0`, пока «никого не
      было» пришло сообщение, возобновились с `2.1.0` — приехала ровно одна новая строка `2.2.0`,
      без повтора прежней.
- [x] `--framed` даёт конверт `{data, cursor}`; курсор из `STITCHWIRE_STREAM_CURSOR` подхватывается;
      негодный курсор — сообщение с причиной и код возврата 1.
