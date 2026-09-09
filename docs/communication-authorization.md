# Основание для межсессионной переписки

`message.send`, `ccmux msg`, адресованный сессии `ccmux relay` и remote chat reception
требуют основание до записи письма. Правило одинаково для managed, role, fleet-prefixed
и exact App addresses. Наличие транспорта, reply address или `onBehalfOf` не является
разрешением. Обход отказа другим инструментом ввода не допускается.

## Три основания

| basis | Что передаёт отправитель | Что проверяет CCMux |
| --- | --- | --- |
| `user-instruction` | Обоснование, дословную цитату человека, ссылку на его сообщение | Форму заявления; содержимое внешнего разговора CCMux не удостоверяет |
| `peer-letter` | Обоснование, дословную цитату из письма соседа, `<peer thread uuid>#<message uuid>` | Наличие письма, точных отправителя и получателя, совпадение треда и task, наличие цитаты в тексте |
| `thread-continuation` | Только `sourceMessageRef` на собственное принятое письмо этой переписки | Ту же пару endpoints, тред, task и наличие сохранённой начальной расписки |

`CommunicationAuthorizationInputSchema` — схема новых запросов, экспортируемая control
service client. `basis` обязателен. `CommunicationAuthorizationSchema` описывает
сохранённые наблюдения: историческая запись без `basis` остаётся без него, но не
принимается как новый запрос. Отсутствие факта не превращается в разрешение.

У двух открывающих оснований обязательны:

- `whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope`: 40–4000 символов
  после trim — зачем нужен этот адресат, какой результат ожидается и чем ограничена работа.
- `userAuthorizationQuote`: 1–4000 символов, не пробельная строка; сохраняется дословно.
- `sourceMessageRef`: 1–1000 символов после trim.

Неизвестные поля запрещены. У continuation обоснование и цитата запрещены: оно ссылается
на уже принятое основание, а не переписывает его. Один файл continuation можно повторно
использовать для той же пары и того же `--task`, ссылаясь на одно принятое письмо.

## Форма файлов

Первое письмо по разрешению в собственном разговоре:

```json
{
  "basis": "user-instruction",
  "whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope": "Contact the designated reviewer to obtain the requested review result within the agreed scope.",
  "userAuthorizationQuote": "<дословные слова пользователя>",
  "sourceMessageRef": "<ссылка на сообщение пользователя>"
}
```

Ответ на разрешение, переданное соседом:

```json
{
  "basis": "peer-letter",
  "whyThisCommunicationIsNecessaryAndWithinTheUserAuthorizedScope": "Reply to the designated reviewer within the work authorized in the referenced letter.",
  "userAuthorizationQuote": "<дословная цитата из письма>",
  "sourceMessageRef": "<peer thread uuid>#<message uuid>"
}
```

Следующие письма:

```json
{
  "basis": "thread-continuation",
  "sourceMessageRef": "<peer thread uuid>#<идентификатор своего принятого письма>"
}
```

UUID берутся из адресной строки письма, а не придумываются. Peer thread — тред соседа,
написавшего исходное письмо, либо адресата продолжаемой переписки.

CLI получает файл через `--communication-authorization <JSON file>`; чтение ограничено
64 КиБ и regular file. Цитата не попадает в process arguments или error output.
Отказ показывает три основания и форму файла. Файл с частными цитатами следует хранить
с ограниченными правами доступа.

## Пара, задача и долговечная расписка

Переписка связана с exact identities обеих сторон: machine, runtime, managed session и
thread либо App thread. Переиспользованное имя сессии не означает ту же переписку.
`task` должен точно совпадать, включая `null`; для другой работы нужно новое основание.
`peer-letter` разрешает ссылку только при ответе автору этого письма, не третьей стороне.

В `communicationReceipt` сохраняются `rootMessageId`, исходное заявление и
`sourceLetter` — полный текст, ID, время, стороны и task письма-основания. Для прямого
user instruction `sourceLetter=null`: CCMux не заявляет, что прочитал внешний разговор.
Письмо-основание ограничено 16 384 символами; превышение явно отклоняется, текст не режется.

Каждое continuation наследует одну исходную расписку, без растущей цепочки копий и
повторного объяснения. Сообщение без разрешения или без разрешённой начальной расписки
не может служить основанием continuation. Источник — append-only ledger и outbound
envelope, а не отдельный изменяемый registry разрешений.

Ссылка разрешается на originating host. Входящий транспорт несёт уже разрешённую
расписку; принимающий узел не выдумывает результат чтения чужого диска. Remote
`message.send` с reference-based основанием отклоняется: его следует разрешить на
originating host через `msg`. Прямое `user-instruction` остаётся явно непроверенным
заявлением. Это не remote lookup и не fallback.

## Приёмка и проекции

Control input содержит `communicationAuthorization`; `null` допустим только для
service caller с human application channel, допущенным host `messageApplications`.
CLI и managed caller не могут объявить себя человеком. Raw remote envelope не
предоставляет этого исключения. Attributed input дополнительно пиннит registration
generation, когда она есть у адресуемой сессии.

Исходное заявление и расписка доступны в JSON log/feed. Они не добавляются к тексту
доставленного сообщения или уведомления. Oversized feed явно исключает evidence целиком,
не обрезая цитату; полная запись остаётся в ledger по message ID. Повтор одного ID с
другим заявлением конфликтует. Owner notifications и cancellation не требуют основания
межсессионного обращения.

## Граница доверия

Расписка подтверждает запись заявления, **не согласие человека**. Даже точное совпадение
цитаты с письмом агента не доказывает, что человек это говорил. Смысл разрешения, срок,
ограничение числа писем, последующий отзыв и допустимость конкретного действия проверяет
слой, владеющий разговором. CCMux не извлекает ограничения из прозы и не выдаёт credential
по совпадению подстроки.

Разрешение переписки не разрешает передачу файлов или изменение чужого репозитория.
Такие операции сохраняют собственную пообъектную приёмку; этот контракт не заменяет
handoff authorization. Он также не перехватывает инструменты других продуктов или
произвольный shell и не является sandbox для злонамеренного агента.

Live acceptance требует настоящего разрешения. Изолированные тесты используют только
синтетические письма и не обращаются к живым сессиям.
