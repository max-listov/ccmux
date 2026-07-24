---
title: Router-сессия + queue-until-idle доставка (autonomous manager)
description: Follow-up доставляется в целевую сессию строго когда она ДОБРОВОЛЬНО завершила turn (никакого steering), с honest-провенансом владельца; плюс роутер-сессия (Sonnet), которая маршрутизирует, дожидается и валидирует ответ, не дёргая человека. Дизайн переработан после валидации 3 независимыми ревью.
type: task
status: done
created: 2026-07-24
updated: 2026-07-24
completed: 2026-07-24 20:55 +07:00
---

# Router-сессия + queue-until-idle доставка (autonomous manager)

> Источник: голосовая постановка the maintainer (2026-07-24), проработано в отдельной планирующей сессии.
> Строит эту фичу dev-сессия этого репо. **До явного «делай» от the maintainer — только анализ/подготовка.**
> Дизайн ниже — уже ПОСЛЕ проверки контракта Stop hook по докам + 3 независимых адверсариальных
> ревью плана (их выводы сведены; расхождения разрешены; исходный план в git-истории сессии).

## Проблема (корень, подтверждён)

the maintainer работает с несколькими параллельными Claude-сессиями. Наговаривает войсом задачу, отправляет,
сессия работает 2–10 мин. Когда прилетает **добавка** (follow-up) во время работы, она **перебивает
текущий turn** — агент отвлекается.

**Почему (факт):** нативная очередь Claude Code — это **steering**: введённый во время turn'а текст
флашится на ближайшей LLM-паузе (между тул-коллами), а НЕ в конце turn'а. Настоящего «доставить
строго в конце turn'а» в CLI нет.

**Что нужно the maintainer:** добавка приходит в целевую сессию **только когда агент ДОБРОВОЛЬНО завершил turn**,
и приходит **с весом человека** (не как каприз стороннего агента). Плюс роутер, который это
маршрутизирует и **автономно доводит**: дожидается, валидирует, переспрашивает при расхождении,
эскалирует к the maintainer только при реальном затыке — без «продолжить?».

---

## Ключевой сдвиг после ревью (что было неверно в первом плане)

1. **`stop_hook_active` СУЩЕСТВУЕТ** (эмпирически P3/P4: `false` на 1-м Stop, `true` на Stop после
   нашего `block` — док-агент ошибочно отрицал). Годится вторичным луп-гардом. Первичный гард всё
   равно = **продвижение durable ack-записи** (пусто → `exit 0`). ⚠️ **`stop_reason` в payload НЕТ**
   (док-агент ошибочно утверждал обратное) — гейтить по `end_turn` нельзя, полагаемся на «Stop = turn
   закончился». Реальные ключи payload — см. «Проверенный контракт» ниже.
2. **R5 «atomic writes с обеих сторон» НЕ лечит гонку.** `atomicWrite` защищает от *рваного* файла,
   не от *lost update*. Два read-modify-write на один JSON-объект курсоров всё равно затирают друг
   друга (демон вообще пишет весь объект `cursors`, затирая поле хука даже для другой сессии). А так
   как продвижение записи — это ЕДИНСТВЕННЫЙ луп-гард, потерянный апдейт = бесконечный
   `block`→turn→`block`, сессия не может остановиться. Это не «дубль», это **вклинивание сессии**.
3. **Hook и demon покрывают ДИЗЪЮНКТНЫЕ состояния, ни один не «primary/backstop»:**
   - **Stop hook физически НЕ стреляет по уже-idle сессии** (нет завершающегося turn'а). А это ровно
     частый кейс the maintainer — follow-up часто прилетает *после* того как turn закончился. Hook-only → молча
     никогда не доставит уже-простаивающему таргету.
   - **Демон-скрейп idle не airtight в середине turn'а** (ложное «конец turn'а» между тул-коллами).
   - Вывод: **демон-`waiting` = хребет для ВСЕХ idle-таргетов** (уже-idle + silent-tool-stop);
     **hook = точный сигнал ровно для mid-turn кейса**, который демон надёжно поймать не может.
4. **«Как будто написал человек» конфликтует с peer-trust границей.** Follow-up **исходит от
   владельца** (the maintainer продиктовал роутеру) → его авторитет = user-level. Но `from=router` рендерит его
   как peer (`[chat from router]`) — и не по-человечески, и неверный вес доверия. **Решение: не
   спуфить `from`, а нести honest-провенанс** (`onBehalfOf: "owner"`) и рендерить как «владелец
   просит (передал роутер): …» — честный курьер, верный авторитет, человеческий вес без имперсонации.
5. **Echo-ответ строить НЕ надо.** `replyTo` + awaiting-echo + `last_assistant_message` — самая
   хрупкая часть (какой Stop = ответ? пустой текст на tool-ending turn? второй писатель состояния).
   Таргет — полноценный агент, уже умеет `ccmux msg <router>`. Кладём инструкцию «доложи роутеру, как
   доделаешь» в тело follow-up'а; роутер может ещё и сам смотреть `ccmux transcript <target> --json`.

---

## Архитектура: state-disjoint hybrid

```
  the maintainer (голос: мобилка Claude / терминал)  ──"добавь таргету: как доделаешь — сделай X"──▶
  ┌──────────────────┐  router = ccmux-сессия (Sonnet), chat on, менеджер-протокол-промпт
  │  router (Sonnet) │  ── ccmux msg <target> --defer  (provenance=owner)  ──▶  ledger
  └──────────────────┘

  ledger (~/.ccmux-chat.jsonl, append-only, source of truth)  +  ack-log (append-only)
        │
        ├── target MID-TURN (working)  ─▶  Stop hook таргета на КОНЦЕ turn'а:
        │       `ccmux stop-hook` дренит defer-mail → {decision:block, reason:<batch>} → вброс
        │       как человеческий turn; ЗАПИСЬ в ack-log (НЕ в cursors)
        │
        └── target УЖЕ-IDLE (waiting стабильно ≥grace)  ─▶  daemon deliverPending:
                paste+Enter в idle-пейн (НЕ steering) ; демон — единственный писатель cursors
        │
        ▼   идемпотентность: compare-after-append по message-id в ack-log → ровно один инжектор
  target делает работу → сам шлёт `ccmux msg <router> "<результат>"` (обычной доставкой)
        ▼
  ┌──────────────────┐  ВАЛИДАЦИЯ против заранее заданного done-критерия
  │  router (Sonnet) │  ├─ ок  → закрыть, the maintainer не дёргать
  └──────────────────┘  └─ нет → ccmux msg <target> --defer «не сделал Y, доделай» → снова ждёт
                         эскалация к owner — только реальный затык
```

**Разделение ответственности (ни один не «backstop»):**

| Состояние таргета когда прилетел defer | Кто доставляет | Почему единственный кто может |
|---|---|---|
| **working** (mid-turn) | **Stop hook** (`block`+`reason`) | Единственный сигнал завершения turn'а от самого Claude; иммунен к ложному idle между тул-коллами |
| **уже idle / waiting** | **daemon** (стабильный `waiting` + paste) | Stop-события НЕ будет; демон — единственный, кто может действовать |

---

## Модель состояния доставки (нейлить ПЕРВОЙ — всё остальное на ней)

Это самое важное решение. Два инвариантных правила:

1. **Демон остаётся ЕДИНСТВЕННЫМ писателем `cursors`** (`store.ts:70`, инвариант `schema.ts:177`
   сохраняется дословно). Hook **никогда не пишет `cursors`**.
2. **Hook фиксирует доставку defer'а append-only записью в отдельный ack-log** (или типизированной
   строкой в ledger). `O_APPEND` однострочная запись атомарна между процессами — это весь дизайн
   ledger'а (`store.ts:49-55`). Нет shared RMW → **R5 растворяется, а не патчится.**

**Идемпотентность (lock-free):** перед инъекцией любой путь проверяет ack-log на этот message-id;
после своего append — перечитывает хвост и уступает, если раньше уже есть ack (**compare-after-append**:
порядок append даёт тотальный порядок → ровно один инжектор выигрывает). Тяжёлая альтернатива —
per-recipient `mkdir`-лок (стандартный паттерн межпроцессной блокировки), если захочется belt-and-suspenders.

**Grace-handoff для граничной гонки:** демон доставляет defer только когда таргет стабильно в
`waiting` **≥ grace (≥2 поллов / ~8с)**. Инъекция хука мгновенно флипает таргет в `working` →
подавляет демон-путь. Демон дотягивает до порога только когда хук НЕ стрелял (silent-stop / уже-idle).

**Head-of-line:** держим одну монотонную `delivered[target]` (элегантно). Демон при `next.msg.defer`
и working-таргете **держит на `next.idx`, НЕ продвигая** (как rate-limit `continue` в `deliver.ts:84-87`,
не caught-up-advance `73-77`) — ждёт, пока хук продвинет через ack. ⚠️ Побочка: придержанный defer
блокирует и последующие сообщения этому таргету — осознанное поведение, задокументировать.

---

## Провенанс (honest, без спуфинга)

- `from` **никогда не подделывается** (сохраняем `msg.ts` «sender cannot be spoofed»).
- Новое поле `onBehalfOf` на сообщении. `from=router, onBehalfOf=owner` → рендер:
  **«[владелец просит, передал router] …»** — user-level trust, человеческий вес, без имперсонации.
- Только `from ∈ {owner, cli}` (человеческая сторона, `store.ts:11-16`) рендерится полностью
  по-человечески; сообщения агент-происхождения сохраняют peer-фрейм `[chat from <from>]`.
- **Общий форматтер** `[chat from …]`/провенанс-обёртки — ОДНА функция, используемая И хуком, И
  пейн-доставкой (`deliver.ts:33-34`), иначе таргет не распознаёт peer-тег → тихий слом trust-границы.

---

## Фазовая стройка (де-рискинг: сначала самое тупое верное)

**Фаза 1 — MVP доставки (демон, без хука/роутера/echo).**
`ccmux msg <target> --defer` из CLI (provenance=owner) → демон доставляет на **стабильном `waiting`**.
Единственный писатель курсоров, все инварианты целы, крошечный диф, без `--settings`-хирургии.
Валидирует два реальных неизвестных дёшево: надёжность pane-idle детектора и «queue-until-idle» вообще.
Покрывает ВСЕ idle-таргеты (уже-idle + silent-stop). НЕ покрывает mid-turn точно — это Фаза 2.

**Фаза 2 — Stop hook для точной mid-turn границы.**
`ccmux stop-hook` + авто-прописка + ack-log + grace + compare-after-append (R5 верно). Детали ниже.

**Фаза 3 — роутер + язык.**
Роутер-сессия (Sonnet) + менеджер-протокол-промпт (fork 3) + зеркалирование языка владельца (fork 4).
Роутер — **prompt-слой поверх готового механизма**; авторство follow-up'а всегда owner, с роутером или без.

---

## Объём работ по компонентам (с якорями)

- **A. Schema** (`schema.ts:166`): добавить `defer: boolean = false` + `onBehalfOf: string|null = null`
  в `ChatMessageSchema`. Дефолты → старые строки ledger валидны (`store.ts:44`). **`replyTo` НЕ вводим.**
- **B. `ccmux msg --defer`** (`msg.ts:22-29`): `--defer`→`defer:true`. `onBehalfOf` ставит роутер/CLI
  при owner-relay. Sender по-прежнему автоматический.
- **C. Defer-gate в `deliverPending`** (`deliver.ts:54`): для defer-сообщения вычислить состояние —
  `provider.scanPane` + `lastTranscriptMessage` (`agent/index.ts:183`) для настоящего `waiting`
  (`status.ts:59`); доставлять **только при стабильном `waiting`** (≥grace), иначе **держать на idx**
  (не продвигать). Non-defer — как сейчас. (Сейчас `deliverPending` транскрипт НЕ читает — это новая
  зависимость, mtime-кэш, только для defer-получателей с почтой.)
- **D. `ccmux stop-hook`** (нов. `commands/stopHook.ts` + `cli.ts:53`): stdin JSON → сессия по
  **`CCMUX_SESSION`** (env, стабилен). (`stop_reason` в payload НЕТ — по нему НЕ гейтим; Stop = turn
  завершился. `last_assistant_message === "<no content>"` = молчаливый turn.)
  Дренит defer-mail `to==self` без ack → `{decision:block, reason:<batch, через общий форматтер>}`;
  **append в ack-log ДО печати decision** (fail-closed: ack не записался → не инжектим); пусто → `exit 0`.
  Весь хук в try/catch → любая ошибка = `exit 0` без инъекции (fail-open против wedge).
- **E. Авто-прописка Stop hook** (`launch.ts:34`): мержить в ЕДИНЫЙ `--settings`-объект
  (`{disableRemoteControl?}` только при RC-off ⊕ `{hooks:{Stop:[…]}}`). Команда хука = `promptInvocation()`
  (`env.ts:59`, уже прокинут как `cli` в `buildArgv`) + ` stop-hook`. **Прописывать для ВСЕХ managed
  Claude-сессий безусловно** (декупл от рантайм-тоггла `chatEnabled`), а `stop-hook` дёшево no-op'ит,
  читая живой `chatEnabled`. Гейт `s.agent==='claude'` (у Codex нет `--settings`/hooks).
- **F. Роутер-сессия + протокол-промпт** (нов. prompt-модуль по образцу `managePrompt.ts`).

---

## Решённые развилки

**Fork 1 — владелец defer-доставки:** ✅ **state-disjoint hybrid.** Hook = mid-turn; демон-стабильный-
`waiting` = хребет для всех idle. Координация: append-only ack-log + grace + compare-after-append.
Демон — единственный писатель курсоров; хук пишет только ack-log. НЕ «primary/backstop».

**Fork 2 — echo-ответа:** ✅ **не строить.** Таргет сам шлёт `ccmux msg <router>` (инструкция в теле
follow-up'а); роутер дополнительно может `ccmux transcript <target> --json`. `replyTo`/`last_assistant_message`
выкинуть.

**Fork 3 — протокол-промпт роутера (обязательный отдельный deliverable):** должен пиновать:
1. **Роут:** таргет из `ccmux list`/`transcript` по описанию; неоднозначно → **спросить владельца, НЕ гадать**.
2. **Формулировка:** императив, self-contained, **без раздувания скоупа**, с done-критерием и футером
   «доложи роутеру, как доделаешь».
3. **Доставка:** только `ccmux msg <target> --defer`; **НИКОГДА `ccmux send`/сырые кнопки** в живой пейн.
4. **Non-interference:** не слать non-defer работающему таргету; не `restart`/`stop`/`mode` «чтоб помочь»;
   наблюдение — read-only.
5. **Валидация:** против заранее заданного done-критерия объективно, не по самоотчёту.
6. **Ретрай-кап:** ≤2, каждый — с конкретикой расхождения.
7. **Эскалация к owner:** повторный провал после капа / неоднозначно/рискованно/деструктивно / таргет
   спрашивает то, что знает только владелец / затык.
8. **Anti-nag (жёстко, топ-раздражитель the maintainer):** НИКОГДА не пинговать owner «продолжить?/сделать?/готово?»;
   только реальный блокер или финал; молчание-в-работе — норма.
9. **Идентичность/trust:** роутер — peer, НЕ имперсонирует владельца; owner-происхождение несётся честно
   (`onBehalfOf`), не спуфом.
10. **Язык:** отвечать владельцу на языке владельца (fork 4).
11. **Идемпотентность/loop:** не переслать уже отправленное; уважать rate-guard (`deliver.ts:15-16`);
    router↔target пинг-понг → стоп + эскалация.

**Fork 4 — язык owner-канала:** ✅ **зеркалить язык владельца** (строка во фрейминге) как дефолт;
опциональный `ownerLang` в `machine.json` (по умолчанию unset) — только оверрайд/cold-start. Без
хардкода конкретного языка (публичный репо). Строку добавить и в `ccmux msg owner`-гайд `managePrompt.ts`.

---

## Риски / дырки (сведено из 3 ревью)

| # | Риск | Статус/решение |
|---|---|---|
| R2 | `--settings`-коллизия: сегодня объект есть ТОЛЬКО при RC-off; на маке RC **on** → объекта нет вовсе | Всегда эмитить один объект при нужде хука, `disableRemoteControl` — условным ключом |
| R2b | Как inline `--settings` мержит **массив** `hooks.Stop` с глобальным `~/.claude/settings.json` (юзер может держать свои глобальные хуки, напр. PostToolUse) — replace или concat? | ⚠️ **ПРОВЕРИТЬ ЭМПИРИЧЕСКИ до кода** (пробник P1). Может тихо затереть юзерские хуки |
| R3 | #29881 (silent-tool-stop) не подтверждён | Демон-`waiting` уже покрывает silent-stop как хребет; НЕ строить третий хрупкий механизм под фантом |
| R4 | `loadLedger` читает+Zod-парсит **весь** ledger на КАЖДОМ Stop каждой сессии, ledger не ротируется → O(ledger)/turn на критическом пути | Хук читает сырьё tail-scan'ом без полного `parse`; позже — byte-offset чекпоинт / ротация |
| R5 | Два писателя курсора → lost update → **бесконечный `block`-луп** | ✅ Ack-log append-only + демон единств. писатель курсоров + compare-after-append |
| N1 | Head-of-line: придержанный defer блокирует поздние сообщения таргету | Держать на idx (единая монотонная), задокументировать поведение |
| N2 | `session_id` из payload ≠ registry `uuid` после fork'а Claude (`agent/index.ts:36`) → хард-кросс-чек ломается на долгоживущих сессиях | Идентичность по **`CCMUX_SESSION`**; `session_id` — только мягкий лог |
| N3 | `reason` хука без тега = таргет читает peer как человека (trust slip) | Общий форматтер провенанса для хука и пейна |
| N4 | Хук инжектит, пока **человек приаттачен** к пейну таргета (у хука нет `hasAttachedClient`, `deliver.ts:88`) | Добавить проверку attach в хук ИЛИ осознанно решить, что end-of-turn инъекция при аттаче ок |
| N5 | Хук может wedge'нуть stop при исключении | Весь хук try/catch → `exit 0` |
| N6 | Два канала инъекции (хук stdout vs демон paste) могут интерливиться даже для non-defer | Координировать per-target: демон не пастит в сессию, только что ушедшую в working |
| N7 | Изолированный dev-инстанс (`tmuxSocket`): хук обязан резолвить ledger ИНСТАНСА через унаследованные `CCMUX_CONFIG`/`CCMUX_SESSIONS` | Не хардкодить путь в команде хука; тест «хук читает store инстанса, не прод» |
| N8 | Telegram-mirror зеркалит defer владельцу немедленно (`telegram.ts:17`) — the maintainer видит каждый relay | Решить: гейтить mirror на `!defer` или рендерить отлично |
| N9 | Демон-доставка двигает `delivered`+`read`; хук-доставка — ни то ни другое → рассинхрон `ccmux inbox` | Ack-log — единый источник для defer; демон сверяет `read` при no-op |
| N10 | **(найдено при e2e)** Хук дедупит по ack-log; потеря ack-log при живом ledger → переотправка всей истории defer | ✅ **Две независимые durable-защиты** (разные файлы): ack-log по id **И** `delivered`-курсор демона как read-only floor в хуке. Плюс: чистка chat-стейта чистит ledger+cursors+ack вместе |

---

## Решающие пробники — ВЫПОЛНЕНЫ (2026-07-24, `claude -p` + инспекция транскрипта)

1. **P1 — merge/clobber: ✅ PASS.** `--settings '{"hooks":{"Stop":[…]}}'` — наш Stop выстрелил
   **И** одновременный проектный PostToolUse-хук тоже (`posttool.fired`). Мерж **по-событийно**,
   другие события не затираются → чужие глобальные хуки юзера (напр. PostToolUse) уцелеют. (Строго-решающий вариант —
   user-global PostToolUse + `--settings` Stop — та же машинерия мержа; остаточный риск низкий.)
2. **P2 — mid-turn split: ✅ подтверждено (статически).** Транскрипт дробит turn на ОТДЕЛЬНЫЕ
   assistant-строки (thinking / text / tool_use — 14/7/4, никогда вместе). → `lastMessage=assistant-text`
   бывает mid-turn до следующей tool_use-строки → демон-`waiting` **обязан** иметь stability-окно (≥2 полла),
   хук остаётся нужен для точной mid-turn границы.
3. **P3 — block→turn: ✅ PASS.** `{decision:block,reason}` → модель выдала ровно инъецированный turn
   (`BANANA`). `stop_count=2` (block→inject, затем exit 0→stop).
4. **P4 — silent-stop (#29881): ✅ НЕ воспроизводится.** turn, завершённый на tool_result БЕЗ текста,
   **всё равно вызвал Stop** (`last_assistant_message="<no content>"`). → хук ловит и silent-endings;
   демон нужен **только для уже-idle таргета** (Stop-события уже не будет). Спекулятивный backstop не нужен.

---

## Порядок

**Пробники P1–P4** (де-риск) → **Фаза 1** (A,B + демон-`waiting` defer-gate, единственный писатель) →
**Фаза 2** (D,E + ack-log/grace/compare-after-append) → **Фаза 3** (F + язык). Тестировать послойно в
изолированном dev-инстансе (`scripts/dev-instance.sh`).

## Definition of Done

- [x] **Фаза 1:** `ccmux msg <target> --defer` кладёт defer; демон доставляет ТОЛЬКО на стабильном
      `waiting` (mtime-grace 6с), держит (не продвигает курсор) пока таргет working. ✅ e2e: держался 33с
      работы вкл. транзиентные idle-кадры, доставлен на добровольном idle. Провенанс `onBehalfOf` —
      shared-форматтер `chat/format.ts` (юнит-тесты).
- [x] **Фаза 2:** `ccmux stop-hook` дренит defer-mail на end-of-turn, вбрасывает `block+reason` общим
      форматтером, пишет ack-log (не курсоры), fail-open; авто-прописан в единый `--settings` для
      chatEnabled Claude-сессий; идентичность по `CCMUX_SESSION`. ✅ e2e: держался весь 15с-turn, доставлен
      ровно на end_turn хуком (`ack_by=hook`), быстрее демонского grace; демон подхватил курсор без дублей.
- [x] R5 закрыт: хук НЕ пишет курсоры (демон — единственный писатель); дедуп через append-only ack-log
      (+ read-only floor курсора, N10). Нет бесконечного `block`-лупа (продвижение ack, fail-closed перед emit).
- [x] P1–P4 эмпирически подтверждены (`claude -p`). `stop_hook_active` есть, `stop_reason` нет — учтено.
- [x] **Фаза 3:** роутер с протокол-модулем маршрутизирует, дожидается, валидирует, эскалирует, НЕ
      нагаживает owner; отвечает на языке владельца. ✅ Активация — **`promptModules: string[]`** (data-key
      → live код-модуль на launch; выбрано после валидации 3 агентами: любой хранимый текст = дрейф,
      `--append-system-prompt` — last-wins → протокол конкатенируется В строку `buildPrompt`). rule #31
      снят (как `chatEnabled`: capability-данные, не роль). `--router` сахар + `ccmux router on|off`.
- [x] E2E цельный: ✅ owner продиктовал роутеру → роутер `msg dev-b --defer --on-behalf-of owner` (сам
      работу не делал; provenance-гейт пропустил только т.к. router) → воркер получил на end-turn → создал
      файл → отчитался роутеру (non-defer, демоном) → роутер **валидировал по факту, не со слов** → доложил
      владельцу, БЕЗ нытья. Ретраи не понадобились.

## Прогресс реализации (2026-07-24)

- **Все три фазы — построены и валидированы e2e в изолированном dev-инстансе, `bun run check` = 135/0.**
- **Фаза 3 — активация роутера решена как `promptModules: string[]`** (3 агента: гибрид с хранимым текстом
  = дрейф; `--append-system-prompt` last-wins-затирание доказано → конкат В `buildPrompt`; rule #31 снят
  прецедентом `chatEnabled`).
- Тронутый код по фазам:
  - Ф1: `config/schema.ts` (defer/onBehalfOf), `chat/format.ts` (нов., shared framer), `chat/deliver.ts`
    (defer-gate stable-idle), `commands/msg.ts` (`--defer`).
  - Ф2: `chat/store.ts` (ack-log), `chat/deliver.ts` (ack-координация), `commands/stopHook.ts` (нов.),
    `cli.ts` (роут), `agent/claude/launch.ts` (авто-прописка Stop-hook в единый `--settings`).
  - Ф3: `config/schema.ts` (promptModules/ownerLang), `agent/promptModules.ts` (нов., реестр + router-протокол),
    `agent/managePrompt.ts` (компоновка модулей + язык owner), `commands/new.ts` (`--router`),
    `commands/router.ts` (нов.), `config/sessions.ts` (`setSessionRouter`), `commands/msg.ts` (`--on-behalf-of` + гейт).
- Тесты (нов.): `chat-format`, `stop-hook`, `router-prompt`, `msg-provenance` + правки литералов.
- **Осталось:** ship в прод (по approval the maintainer — правило репо: не шипить без явного «да») → затем `git mv` в `done/`.

## Референсы

- Agent Room — Stop hook long-poll mailbox (block+reason). У них Redis; у нас ledger+ack-log.
  https://dev.to/agent-room/how-a-claude-code-stop-hook-unlocks-async-multi-agent-collaboration-no-polling-required-2e0e
- Официальный Agent Teams (lead+mailbox+`TeammateIdle` hook) — валидирует «router-lead», но не тянет
  cross-machine долгоживущие сессии. https://code.claude.com/docs/en/agent-teams
- Hooks reference: https://code.claude.com/docs/en/hooks
- Issues (контекст): #49373 (queue at true end-of-turn), #50246 (queue mode), #29881 (silent-stop —
  не подтверждён), #30492/#71726/#36326 (steering/inject-mid-task).

## Проверенный контракт Stop hook (ЭМПИРИЧЕСКИ, `claude -p`, 2026-07-24 — бьёт доки)

- `--settings <file-or-json>` — инлайн JSON или путь, мерж **по-событийно** (P1: наш Stop + сторонний
  PostToolUse сосуществуют). Несёт `hooks.Stop`.
- **Реальные ключи payload:** `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
  `effort`, `hook_event_name`, **`stop_hook_active`** (есть! `false`→`true` после нашего block),
  `last_assistant_message` (`"<no content>"` при молчаливом turn'е), `background_tasks`, `session_crons`.
  ⚠️ **`stop_reason` и `turn_index` — ОТСУТСТВУЮТ** (док-агент их выдумал).
- `{"decision":"block","reason":"<text>"}` (exit 0) — не даёт встать, `reason` инъецируется как
  следующий turn (P3: подтверждено — модель выдала ровно инъекцию).
- Хук-субпроцесс **наследует env** запущенного `claude` (→ `CCMUX_SESSION` виден).
- Stop стреляет и на silent-tool-ending (P4) — #29881 не воспроизведён в этой версии.
