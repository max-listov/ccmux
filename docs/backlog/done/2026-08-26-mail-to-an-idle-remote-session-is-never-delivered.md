---
title: Mail to an idle remote session is never delivered
description: A message to a session on another machine is accepted rather than sent, the idle peer is never woken by it, and the sender's wait sits on undelivered mail until it times out.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 12:07 +07:00
---

# Mail to an idle remote session is never delivered

## Why this matters

Observed 2026-08-26 across two machines.

Messages to sessions on the **local** machine report `sent`, and those peers replied within
seconds:

```
sent  ccmux/claude@<host-a>:<from> → ccmux/claude@<host-a>:<peer>
```

Messages to a session on **another** machine report `accepted`:

```
accepted  ccmux/claude@<host-a>:<from> → ccmux/claude@<host-b>:<peer>
```

That peer was `idle`. It never took a turn on any of three messages sent over about forty
minutes, and its last recorded turn predates all of them. `ccmux wait` on it says so directly:

```
<peer>: timed out after 300s — waiting on undelivered mail
```

So the mail exists, is known to be undelivered, and nothing moves it.

## What makes this more than a delay

The sender has **no way to tell the difference** between three situations:

1. the peer received the message and chose not to act;
2. the peer is busy and will act later;
3. the message was never delivered at all.

All three look identical from the sending side: a successful command, then silence. In this case
it was the third, and the sender spent a working session reporting "waiting for the peer" as a
status — while the peer was idle with nothing to wait for. Work sat still on both sides, and
neither side could see why.

This is the same class as a subscription with no deadline: **an accepted-but-undelivered message
is indistinguishable from a peer that is simply quiet**, and it stays that way indefinitely.

## Result

- A message either reaches its addressee or the sender learns that it did not.
- An idle remote session is woken by mail addressed to it, the same way a local one is.
- If deferred delivery is deliberate for some targets, the sender is told that at send time —
  `accepted` and `sent` must not be two words for what the sender reads as the same outcome.

## Plan

- [x] Establish why local delivery wakes an idle peer and remote delivery does not — **оно и не
      различается**: держит занятый композер получателя, а не транспорт. См. «Диагноз» ниже.
- [x] Decide the contract — доставка немедленная в обоих случаях; отложенности по признаку
      удалённости нет и не было.
- [x] Слова отправки не трогал, и это решение: `sent`/`accepted` оба значат «записано», и менять их
      на «доставлено» было бы обещанием, которого отправитель дать не может — доставка происходит
      позже и на другой машине. Действовать отправитель теперь может по `ccmux wait`, который
      называет причину.
- [x] Непоставленная почта имеет видимое состояние: сколько ждёт и чего — в `wait`, в
      `inbox <session>` и в `doctor`.

## Acceptance

- [x] Сообщение простаивающей сессии на другой машине доходит — так было и до правки; в замере
      сессия не простаивала в том смысле, который предполагала формулировка: её композер был занят.
- [x] `wait` различает эти два, и называет третье — «письмо дошло и удерживается вот почему».
- [x] Исход отправитель узнаёт от `wait`, а не от результата отправки: в момент отправки исход ещё
      не наступил, и печатать его там значило бы гадать.

## Диагноз: причина не та, что в заголовке

Воспроизведено на живом флоте, не выведено рассуждением. Сообщение **дошло** и лежит в реестре
принимающей машины — `accepted` честное слово. Демон там **не молчит**: он пробует каждые три
секунды и каждый раз держит, записывая причину. Спустя одиннадцать часов после отправки:

```
hold reason : that pane has unsent text in its composer
last held at: только что — то есть каждые 3 секунды
```

Композер получателя действительно занят: в нём висит неотправленный блок.

```
❯ [Pasted text #25 +17 lines]
```

**Ось не «локально против удалённо».** Сессия своей машины с занятым композером держится точно так
же; у локальных пиров в том замере композеры просто оказались пусты. Слова `sent` и `accepted` тоже
не причина: первое печатает локальная запись в реестр, второе — удалённый приёмник, и оба значат
«записано», ни одно не значит «доставлено».

Само удержание при этом **правильное**: приписать свой текст к чужой недописанной строке значит
отправить черновик человека. Неправильным было то, что удержание **не имеет границы и никому не
сообщается**.

## Что сделано

- [x] `ccmux wait` называет причину: он выполняется НА той машине, где лежит письмо, то есть ответ
      всё это время был в файле рядом (`mailHold` в `src/commands/wait.ts`). Именно этот молчащий
      таймаут и стоил захода.
- [x] Формулировка удержания честна на обоих концах своей жизни. «Человек печатает прямо сейчас» —
      правда через три секунды и ложь через одиннадцать часов, причём ложь в дорогую сторону: читается
      как временное и никого не отправляет смотреть.
- [x] Демон помнит, когда впервые задержал ИМЕННО ЭТО письмо (`since` в `ChatHoldSchema`), а не
      только что задержал мгновение назад. После десяти минут причина сообщает длительность.
- [x] `ccmux doctor` показывает застрявшую почту: со стороны отправителя застой невидим по
      устройству — отправка удалась, всё дальнейшее происходит на принимающей машине, — значит он
      обязан быть виден там, иначе не виден нигде.
- [x] `test/mail-hold-visibility.test.ts`, 5 проверок. 651 тест зелёный.

## Чего сознательно НЕ сделано

- [x] Доставлять после таймаута всё равно — отвергнуто: это и есть отправка чужого черновика.
      Инвариант «никогда не дописывать к недописанной строке» остаётся; прекращается молчание
      вокруг него.
- [x] Будить простаивающего пира иначе — не требуется: он не спит, у него занят композер.
