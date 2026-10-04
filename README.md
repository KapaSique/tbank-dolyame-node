# tbank-dolyame-node

Типизированный клиент для Node.js: **интернет-эквайринг Т-Банка (EACQ API v2)** и **партнёрский API «Долями»**. Без runtime-зависимостей, TypeScript strict, ESM, Node ≥ 20.

Библиотека закрывает не «happy path» из документации, а то, на чём интеграции реально ломаются: подпись запроса, `HTTP 200` с `Success: false`, корневой сертификат Минцифры, которого нет в Node, mTLS у «Долями», опасные повторы запросов, ровно `OK` в ответ на уведомление, чеки 54-ФЗ, у которых не сходятся суммы.

> **Это не официальный SDK** и не связан с Т-Банком или «Долями». Сделан по публичной документации (источники и степень проверки — в разделе «[Что проверено, а что нет](#что-проверено-а-что-нет)»). Против боевого терминала не запускался.

## Содержание

- [Что внутри](#что-внутри) · [Установка](#установка) · [Быстрый старт: Т-Банк](#быстрый-старт-т-банк)
- [Как читать результат](#как-читать-результат) · [Одно- и двухстадийная оплата](#одно--и-двухстадийная-оплата)
- [Уведомления (вебхуки)](#уведомления-вебхуки-т-банка) · [Чеки 54-ФЗ](#чеки-54-фз)
- [Корневой сертификат Минцифры](#корневой-сертификат-минцифры) · [Белый список адреса страницы оплаты](#белый-список-адреса-страницы-оплаты)
- [Долями](#долями) · [Таймауты, повторы, транспорт](#таймауты-повторы-транспорт)
- [Тестирование](#тестирование) · [Что проверено, а что нет](#что-проверено-а-что-нет) · [Лицензия](#лицензия) · English summary — в конце файла

## Что внутри

| Область | Что есть |
| --- | --- |
| Т-Банк | `init`, `getState`, `checkOrder`, `confirm`, `cancel` (одно- и двухстадийная оплата, отмена/возврат, идемпотентность через `ExternalRequestId`) |
| Подпись | `signToken`, `verifyToken`; сверено с обоими примерами из документации |
| Уведомления | `verifyNotification`, `parseNotification` (сравнение за постоянное время), примеры для Express и `node:http` |
| Чеки 54-ФЗ | `buildReceipt`, `validateReceipt`: копейки, суммы, ФФД 1.05 и 1.2, перечисления из OpenAPI |
| TLS | корень Минцифры + `createRussianTrustAgent()`, `createMtlsAgent()` |
| Долями | `create`, `info`, `commit`, `cancel`, `refund`, `completeDelivery`; mTLS, Basic, `X-Correlation-ID`; карта статусов; разбор вебхуков, проверка IP и сверка через `info` |
| Инфраструктура | настраиваемые адреса, таймауты через `AbortController`, повторы только для безопасных вызовов, подменяемый `transport` |

## Установка

```bash
npm install github:KapaSique/tbank-dolyame-node
```

При установке из GitHub срабатывает `prepare` и собирает `dist/`, поэтому нужны Node ≥ 20 и доступ к npm для dev-зависимостей (`typescript`). Runtime-зависимостей нет: используются только `node:https`, `node:http`, `node:crypto`, `node:tls`.

## Быстрый старт: Т-Банк

```ts
import { TbankClient, buildReceipt, createRussianTrustAgent, isAllowedPaymentUrl, unwrap } from "tbank-dolyame-node";

const tbank = new TbankClient({
  terminalKey: process.env.TBANK_TERMINAL_KEY!,
  password: process.env.TBANK_PASSWORD!,
  agent: createRussianTrustAgent(), // см. «Корневой сертификат Минцифры»
  ffd: "1.2",                       // версия ФФД из личного кабинета; "auto" — принимать обе
});

const amount = 289_800; // копейки
const created = await tbank.init({
  Amount: amount,
  OrderId: "order-1001",       // уникален для каждой операции, ≤ 50 символов
  PayType: "T",                // "O" — одностадийная, "T" — двухстадийная
  NotificationURL: "https://shop.example/webhooks/tbank",
  SuccessURL: "https://shop.example/paid",
  FailURL: "https://shop.example/failed",
  Receipt: buildReceipt({
    ffd: "1.2",
    taxation: "usn_income",
    email: "buyer@shop.example",
    items: [
      { name: "Футболка", price: 129_900, quantity: 2, tax: "none" },
      { name: "Доставка", price: 30_000, quantity: 1, tax: "none", paymentObject: "service" },
    ],
    expectedAmount: amount,    // сумма позиций обязана совпасть с Amount
  }),
});

if (!created.ok) {
  // банк ответил отказом: HTTP 200 + Success=false (или тело ошибки при 5xx)
  const { errorCode, bankMessage, details } = created.error;
  throw created.error;
}
const { PaymentId, PaymentURL } = created.data; // редирект покупателя на PaymentURL

const state = unwrap(await tbank.getState({ PaymentId })); // unwrap бросает TbankError, если ok === false
```

Полный запускаемый пример — [`examples/tbank-payment.ts`](examples/tbank-payment.ts).

## Как читать результат

Т-Банк сообщает о бизнес-ошибках кодом `HTTP 200` и `Success: false`, поэтому «HTTP-запрос прошёл» и «операция прошла» — разные вопросы. Методы клиентов возвращают значение, а исключения оставлены для действительно исключительного:

| Что произошло | Как выглядит в коде |
| --- | --- |
| Операция удалась | `{ ok: true, data, httpStatus }` |
| Банк отказал (`Success: false`, `ErrorCode ≠ "0"`, тело ошибки при 5xx; у «Долями» — любой не-2xx с JSON) | `{ ok: false, error }`: `TbankError` (`errorCode`, `bankMessage`, `details`) или `DolyameError` (`code`, `errorDetailCode`, `correlationId`, `retryAfterSeconds`) |
| Запрос не прошёл локальную проверку (сумма чека, длина полей, формат) | `ValidationError` с полным списком `issues`; в сеть ничего не ушло |
| Сеть, таймаут, TLS | `TransportError`: `kind` (`timeout` / `network` / `tls` / `aborted`), `code`, **`outcomeUnknown`** |
| Ответ не JSON или не того формата (HTML-страница, пустое тело) | `ProtocolError` с `httpStatus` и началом тела |

`Success: true` при ненулевом `ErrorCode` библиотека считает отказом (двусмысленный ответ лучше показать, чем принять за оплату). `unwrap(result)` превращает отказ обратно в исключение.

## Одно- и двухстадийная оплата

| | Одностадийная (`PayType: "O"`) | Двухстадийная (`PayType: "T"`) |
| --- | --- | --- |
| Сценарий | `init` → оплата → `CONFIRMED` | `init` → оплата → `AUTHORIZED` (деньги заблокированы) → `confirm` → `CONFIRMED` |
| Уведомления | банк шлёт сразу два: `AUTHORIZED` и `CONFIRMED` | `AUTHORIZED`, после `confirm` — `CONFIRMED` |
| Отмена холда | — | `cancel` в `AUTHORIZED` → `REVERSED` / `PARTIAL_REVERSED` |
| Возврат | `cancel` после `CONFIRMED` → `REFUNDED` / `PARTIAL_REFUNDED` | то же |
| Неоплаченный платёж | `cancel` в `NEW` → `CANCELED` | то же |

`confirm({ PaymentId, Amount })` может списать сумму не больше авторизованной. `tbankStatusKind(status)` сворачивает статусы в `pending | authorized | paid | refunded | canceled | failed | unknown` — товар отгружайте только после `paid` (`CONFIRMED`). `PAY_CHECKING` и `CONFIRM_CHECKING` дают `unknown`: банк потерял результат после таймаута, перепроверяйте `getState`.

## Уведомления (вебхуки) Т-Банка

Правила, которые задаёт банк: ответить **`HTTP 200` и телом ровно `OK`** (заглавные, без тегов) и только когда событие обработано; иначе банк повторяет доставку (раз в час 24 часа, затем раз в сутки в течение месяца). Ответ ждут 10 секунд.

**`node:http`** (полный код с лимитом тела и разбором ошибок — [`examples/node-http-webhook.ts`](examples/node-http-webhook.ts)):

```ts
import { NOTIFICATION_OK_RESPONSE, NotificationError, parseNotification } from "tbank-dolyame-node";

// внутри обработчика POST /webhooks/tbank, `raw` — Buffer с телом запроса
try {
  const notification = parseNotification(raw, process.env.TBANK_PASSWORD!); // JSON.parse + проверка Token
  await handleOnce(notification);                                           // ваша идемпотентная обработка
  res.writeHead(200, { "content-type": "text/plain" }).end(NOTIFICATION_OK_RESPONSE);
} catch (error) {
  if (error instanceof NotificationError) res.writeHead(400).end(); // подделка / повреждение: заказ не трогать
  else res.writeHead(500).end();                                    // наша ошибка: банк повторит
}
```

**Express 5** ([`examples/express-webhook.ts`](examples/express-webhook.ts)):

```ts
app.post("/webhooks/tbank", express.json({ type: "*/*" }), async (req, res) => {
  if (!verifyNotification(req.body, password)) return void res.sendStatus(400);
  await handleOnce(req.body as TbankNotification);
  res.type("text/plain").send(NOTIFICATION_OK_RESPONSE);
});
```

Что важно:

- **Не меняйте тело до проверки.** В подпись входят *все* скалярные поля корня, в том числе те, о которых библиотека не знает (банк может добавить новые). `Data` и `Receipt` в подпись не входят.
- **Подпись не заменяет сверку с вашим заказом.** Документация прямо требует сравнить `OrderId` и `Amount` с тем, что вы создавали, и не отгружать товар при расхождении. При сомнениях перепроверьте `getState`.
- **Доставки могут повторяться** — обработка обязана быть идемпотентной.
- `PaymentId` в уведомлениях приходит JSON-числом (в ответах `Init` — строкой); клиент приводит его к строке. Идентификаторы больше 2^53 потеряли бы точность при `JSON.parse` — на практике они короче.

### Как считается подпись

Корневые скалярные параметры + `Password` → сортировка по ключу → значения подряд → SHA-256 (UTF-8) → hex. Вложенные объекты и массивы не участвуют, `null`/`undefined` пропускаются, булевы — `"true"`/`"false"`. Сортировка идёт по кодовым единицам UTF-16 (как `Array.prototype.sort()`), а не через `localeCompare`. `tokenInput(params)` показывает строку, которая хешируется, — удобно, когда в кабинете `inittokenisvalid=false`.

## Чеки 54-ФЗ

Все суммы в копейках целыми числами. `19.99 * 100` в плавающей арифметике даёт `1998.9999999999998`, поэтому для перевода есть `toKopecks("19.99")`.

```ts
import { buildReceipt, collectReceiptIssues, validateReceipt, toKopecks } from "tbank-dolyame-node";

const receipt = buildReceipt({ ffd: "1.05", taxation: "osn", phone: "+71234567890", items, expectedAmount: amount });

collectReceiptIssues(someReceipt, { ffd: "1.2", expectedAmount: amount }); // список проблем без исключения
validateReceipt(someReceipt);                                                // ValidationError со всеми проблемами сразу
```

Проверяется то, что описано в документации к `Init` / `Confirm` / `Cancel`:

- сумма `Items[].Amount` равна `Amount` платежа, `Amount` позиции равна `Price × Quantity` (целочисленно, округление половины вверх; для дробного количества допуск задаётся `roundingToleranceKopecks`);
- `Quantity`: до 5 знаков в целой и до 6 в дробной части; ≤ 100 позиций; `Name` ≤ 128 символов;
- `Taxation`, `Tax`, `PaymentMethod`, `PaymentObject`, `AgentSign` — только допустимые значения (списки сверены с OpenAPI-файлом Т-Банка скриптом, а не вручную);
- нужен `Email` или `Phone` (`+` и цифры);
- **ФФД 1.2**: в каждой позиции обязательны `PaymentMethod`, `PaymentObject`, `MeasurementUnit`; допустим расширенный список `PaymentObject`, поля маркировки (`MarkCode`, `MarkQuantity`, `SectoralItemProps`);
- **ФФД 1.05**: свой список `PaymentObject` (включая `composite`), `Ean13`;
- `Payments`: `Electronic` обязателен и равен `Amount`, сумма видов оплаты равна сумме позиций;
- агентские чеки: обязательные поля `AgentData` / `SupplierInfo` в зависимости от `AgentSign`.

Режим `ffd: "auto"` (по умолчанию) принимает значения обеих версий. Версию ФФД библиотека узнать не может — она настроена в кабинете терминала.

## Корневой сертификат Минцифры

**Проблема.** Российские платёжные хосты всё чаще отдают цепочку `…→ Russian Trusted Sub CA → Russian Trusted Root CA`. Корня Минцифры нет в хранилище, которое Node.js поставляет с собой (`tls.rootCertificates`), и обычно нет в системном. Запросы падают с `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` или `unable to get local issuer certificate`, и в логах приложения это нередко выглядит как «банк не ответил». Документация Т-Банка прямо предупреждает: сертификат Минцифры «не входит в доверенные хранилища большинства ОС и языковых рантаймов», а T-API может быть переведён на него в любой момент. Показательно: страница документации `developer.tbank.ru` у системного `curl` на macOS падает с `self signed certificate in certificate chain` (проверено 04.10.2026).

**Решение.** В пакете лежит публичный корневой сертификат и фабрика агента, которая **добавляет** его к `tls.rootCertificates` (а не заменяет их — иначе перестали бы открываться остальные хосты):

```ts
import { createRussianTrustAgent, TbankClient } from "tbank-dolyame-node";

const agent = createRussianTrustAgent();           // публичные корни Node + корень Минцифры
const tbank = new TbankClient({ terminalKey, password, agent });
```

Если сервер не присылает промежуточный «Russian Trusted Sub CA» (ошибка `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), передайте его PEM через `createRussianTrustAgent({ extraCa: [subCaPem] })`. Документация Т-Банка советует ставить оба сертификата. `partner.dolyame.ru` при проверке (04.10.2026) присылал `*.dolyame.ru → Russian Trusted Sub CA → Root`, и одного корня хватало.

Процессный вариант без кода — переменная окружения (так советует и документация Т-Банка; сертификат лежит в [`certs/russian-trusted-root-ca.pem`](certs/russian-trusted-root-ca.pem)):

```bash
NODE_EXTRA_CA_CERTS=./node_modules/tbank-dolyame-node/certs/russian-trusted-root-ca.pem node app.js
```

**Откуда сертификат и как его проверить.** Это «Russian Trusted Root CA» Минцифры России, действителен с 01.03.2022 по 27.02.2032. Официальные источники: страница Госуслуг <https://www.gosuslugi.ru/crt> (на неё ссылается документация Т-Банка) и файл <https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer> (PEM-текст). Не доверяйте копии, не сверив отпечаток:

```text
SHA-256: D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
```

```bash
openssl x509 -in certs/russian-trusted-root-ca.pem -noout -fingerprint -sha256
```

Отпечаток зафиксирован в [`test/tls.test.ts`](test/tls.test.ts), и тест падает при любом расхождении встроенной константы, файла в `certs/` и записанного значения. На этапе разработки он был сверен с файлом на `gu-st.ru`.

`isBundledRootIntact()` пересчитывает отпечаток во время выполнения.

## Белый список адреса страницы оплаты

Хост страницы оплаты (`PaymentURL` у Т-Банка, `link` у «Долями») — это **данные из ответа**, а не константа API. Он может отличаться от хоста API, а провайдер вправе отдавать страницу с нескольких доменов и менять их. Если у вас есть белый список адресов — защита от open redirect, front-end `safeRedirect()`, CSP `form-action`, исходящий фаервол, — то список из одного захардкоженного домена превращает рабочий платёж в «ссылки нет»: банк отвечает `Success: true`, запрос успешен, а покупатель остаётся на сайте без перехода. Такие отказы тихие: в логах нет ни ошибки, ни кода.

Что делать: держать список в конфигурации, вносить в него все домены, которые называет провайдер, и **логировать отказ с хостом**. Для этого есть небольшой помощник:

```ts
import { assertAllowedPaymentUrl, isAllowedPaymentUrl } from "tbank-dolyame-node";

const hosts = ["pay.example.com", "*.pay-mirror.example"];   // из конфигурации, не из кода
isAllowedPaymentUrl(url, hosts);       // только https, без порта и логина, точный хост или поддомен по маске
assertAllowedPaymentUrl(url, hosts);   // то же, но бросает ValidationError с названием хоста
```

## Долями

```ts
import { readFileSync } from "node:fs";
import { DolyameClient, unwrap } from "tbank-dolyame-node";

const dolyame = new DolyameClient({
  login: process.env.DOLYAME_LOGIN!,       // логин/пароль выдаёт персональный менеджер; для демо и боя они разные
  password: process.env.DOLYAME_PASSWORD!,
  tls: { cert: readFileSync("client.crt"), key: readFileSync("client.key") }, // mTLS-сертификат из кабинета Т-Бизнеса
});

const created = await dolyame.create({
  order: {
    id: "shop_1001",                 // уникален; по документации ≤ 30 символов
    amount: 2000,                    // рубли, оплачиваются через Долями
    prepaid_amount: 200,             // уже оплачено иначе (баллы)
    items: [{ name: "Футболка", quantity: 2, price: 1100 }], // amount + prepaid_amount = Σ quantity × price
  },
  client_info: { phone: "+79991112233" },
  notification_url: "https://shop.example/webhooks/dolyame",
  success_url: "https://shop.example/paid",
  fail_url: "https://shop.example/failed",
});
if (!created.ok) throw created.error;           // DolyameError: code, errorDetailCode, correlationId, ...
const { link } = created.data;                  // отправьте покупателя на link
console.log(created.correlationId);             // X-Correlation-ID этого вызова — для логов и обращений в поддержку
```

Остальные методы: `info(orderId)`, `commit(orderId, {...})`, `cancel(orderId)`, `refund(orderId, {...})`, `completeDelivery(orderId, {...})`. Полный сценарий — [`examples/dolyame-order.ts`](examples/dolyame-order.ts).

**mTLS и Basic.** Нужны оба: Basic-логин/пароль и клиентский сертификат. Без сертификата хост отвечает не JSON-ошибкой, а HTML-страницей `400 No required SSL certificate was sent` (проверено 04.10.2026). Клиент превращает её в `ProtocolError` с подсказкой, а конструктор без `tls`/`agent` бросает ошибку сразу. Серверный сертификат `partner.dolyame.ru` выпущен цепочкой Минцифры, поэтому `tls` по умолчанию добавляет корень Минцифры к доверенным (`trustRussianRoot: false` отключает). Параметры `cert`, `key`, `passphrase`, `extraCa` передаются в `https.Agent`; тест поднимает локальный HTTPS-сервер с обязательным клиентским сертификатом и проверяет, что сертификат действительно предъявляется.

**`X-Correlation-ID`.** Обязательный заголовок, UUID v4. По умолчанию генерируется на каждый вызов (`crypto.randomUUID`), можно передать свой: `dolyame.info(id, { correlationId })`. Документация не называет его ключом идемпотентности, поэтому на него не рассчитывайте — это идентификатор операции для логов и поддержки.

### Статусы и карта переходов

| Из | В | Когда |
| --- | --- | --- |
| `new` | `approved` | покупатель прошёл проверку данных |
| `new` | `rejected` | отказ в услуге |
| `new`, `approved` | `canceled` | заказ не оплачен за 24 часа |
| `approved` | `wait_for_commit` | первые 25 % захолдированы, банк готов принять `commit` |
| `wait_for_commit` | `committed` | подтверждение вашим `commit` или автоподтверждение |
| `wait_for_commit` | `canceled` | вызов `cancel` или нет `commit` за 72 часа |
| `committed` | `completed` | первый платёж списан |

Таблица собрана из страниц «Работа с заявкой», «Webhooks», «Тестовая заявка»: заказ живёт 24 часа, `commit` нужно вызвать в течение 72 часов после `create`, отменить заказ можно только в `wait_for_commit`. Карта лежит в `DOLYAME_TRANSITIONS`, и вокруг неё несколько функций:

| Функция | Зачем |
| --- | --- |
| `canTransitionDolyame(from, to)` | один документированный шаг |
| `isDolyameStatusReachable(from, to)` | можно ли дойти до `to` (вебхук мог потеряться) |
| `shouldApplyDolyameStatus(current, incoming)` | **главная**: `false` для дубликатов и опоздавших вебхуков, которые откатили бы заказ назад |
| `canCommitDolyame`, `canCancelDolyame` | `commit` и `cancel` — только в `wait_for_commit` |
| `isTerminalDolyameStatus` | `completed`, `rejected`, `canceled` |

Возвраты статус не меняют: они видны в `refund_info`.

### Вебхуки «Долями»

Документация описывает три шага проверки уведомления: запросить статус через API, проверить IP отправителя, проверить `signature`. Здесь реализованы первые два:

```ts
import { confirmDolyameWebhook, isDolyameWebhookIp, parseDolyameWebhook, shouldApplyDolyameStatus } from "tbank-dolyame-node";

if (!isDolyameWebhookIp(remoteIp)) return;              // 91.194.226.0/23, 91.218.132.0/22, 212.233.80.0/22
const webhook = parseDolyameWebhook(rawBody);            // проверка формы, неизвестный статус → WebhookError
const check = await confirmDolyameWebhook(dolyame, webhook); // вебхук — «будильник», info — истина
if (shouldApplyDolyameStatus(stored.status, check.actual)) { /* применить check.actual */ }
```

За обратным прокси или CDN в `remoteIp` должен попасть адрес, который гарантирует ваш прокси, а не произвольный заголовок клиента. **Подпись `signature` не проверяется:** публичная документация говорит «проверить с помощью секрета по алгоритму SHA-256», но не описывает, из чего считается хеш. Угадывать формулу в платёжной библиотеке неправильно, поэтому защита строится на `info` + IP.

### Идемпотентность и повторы

- `create`, `commit`, `cancel`, `refund`, `completeDelivery` **не повторяются автоматически**, повторяется только `info` (на сетевых ошибках, `429` и `5xx`).
- Если исход `create` неизвестен (`TransportError.outcomeUnknown === true`), не отправляйте заказ заново вслепую: вызовите `info(order.id)`. Идентификатор заказа у вас уникален, он же и якорь идемпотентности. Ожидаемое поведение: `404 NOT_FOUND` — заказ не создан; любой другой ответ — создан (документация это поведение явно не описывает).
- Перед повторным `commit` вызовите `info` и проверьте `canCommitDolyame(status)`.
- `429`: заголовок `Retry-After` попадает в `DolyameError.retryAfterSeconds`, а повторить вызов решаете вы.

## Таймауты, повторы, транспорт

```ts
new TbankClient({
  terminalKey, password,
  baseUrl: TBANK_TEST_URL,                    // https://rest-api-test.tinkoff.ru (нужен IP из белого списка Т-Банка)
  timeoutMs: 10_000,                          // на каждую попытку, AbortController
  retry: { retries: 2, baseDelayMs: 250, maxDelayMs: 4000 },
  validate: true,                             // локальная проверка запросов
  transport: myTransport,                     // полная подмена HTTP-слоя
});
```

| Вызов | Повторы |
| --- | --- |
| T-Bank `getState`, `checkOrder` | да |
| T-Bank `cancel` с `ExternalRequestId` (ключ идемпотентности из документации) | да |
| T-Bank `init`, `confirm`, `cancel` без ключа | нет |
| Dolyame `info` | да |
| остальные методы Dolyame | нет |

Повтор — при сетевой ошибке, таймауте, `429`, `5xx`, с экспоненциальной паузой и джиттером; ошибки TLS не повторяются. `TransportError.outcomeUnknown` говорит, мог ли запрос дойти до сервера: для DNS-ошибки и отказа в соединении это `false`, для таймаута и обрыва — `true`. У ошибок проверки сертификата есть подсказка про `createRussianTrustAgent()`.

`baseUrl` у Т-Банка принимает хост с суффиксом `/v2` или без. Транспорт — функция `(request) => Promise<{ status, headers, body }>`; готовый на `node:https` — `createNodeTransport({ agent })`.

## Тестирование

```bash
npm ci
npm run typecheck   # tsc --noEmit: src, test, examples
npm test            # node --import tsx --test test/*.test.ts
npm run build       # tsc -> dist/
```

Что покрыто (123 теста, без пропусков и заглушек):

- векторы подписи из документации Т-Банка (запрос `Init` и уведомление `AUTHORIZED`);
- уведомления: корректное, подделанное, без `Token`, чужой пароль, неизвестные поля;
- чеки: положительные и отрицательные случаи, ФФД 1.05 и 1.2, агентские чеки, маркировка, суммы;
- построение запросов на поддельном транспорте: URL, заголовки, тело, подпись, `Success: false`, 5xx, не-JSON, повторы, таймауты;
- интеграция: **локальный `node:http`-сервер** изображает банк и проверяет `Token` каждого запроса; полные цепочки одно- и двухстадийной оплаты, возврат, вебхук-примеры на `node:http` и Express;
- TLS: отпечаток корня Минцифры, агент добавляет корень и не теряет `tls.rootCertificates`, реальное TLS-рукопожатие;
- Dolyame: заголовки, ошибки, карта статусов, вебхуки, IP-диапазоны, **настоящий mTLS** (сервер требует клиентский сертификат, отказывает без него и с чужим).

Тесты TLS/mTLS генерируют одноразовые самоподписанные сертификаты через `openssl` (он должен быть в `PATH`; в GitHub Actions на `ubuntu-latest` есть). В репозитории нет ни одного ключа. Сеть тестам не нужна. Прогнано на Node 20.20, 22.23 и 26.

Тестовый контур Т-Банка (`rest-api-test.tinkoff.ru`) требует добавить ваш IP в белый список через чат кабинета и использовать боевой терминал без префикса `DEMO` с тестовыми картами; для «Долями» тестирование идёт на демо-логине/пароле. Ни то, ни другое в тестах репозитория не используется.

## Что проверено, а что нет

**Сверено с официальной документацией** (скачано 04.10.2026): страницы `developer.tbank.ru/eacq` (Init, GetState, Confirm, Cancel, CheckOrder, «Токен», «Уведомления», «Справочник статусов», коды ошибок, «Установка TLS-сертификатов», работа с чеками) и `openapi.yaml` оттуда (v1.36; по словам документации, при расхождениях приоритет у него); `dolyame.ru/develop/api/*` и `dolyame.ru/api/bnpl/partners/swagger.json`. Оба примера подписи воспроизводятся побайтно. Перечисления чека совпали с OpenAPI.

**Проверено вживую** (только чтение, без учётных данных): цепочка TLS у `partner.dolyame.ru` и его ответ без клиентского сертификата; отпечаток корневого сертификата против файла на `gu-st.ru`.

**Не проверено, придётся убедиться самим:**

- **Ни один вызов не отправлялся на живой терминал Т-Банка или в аккаунт «Долями».** Клиенты проверены по документации и на локальных заглушках. Поведение банка на граничных случаях (например, повтор `Init` с тем же `OrderId`) известно из документации и опыта, а не из тестов этого репозитория.
- **Хосты.** Официальная документация указывает `securepay.tinkoff.ru` (бой) и `rest-api-test.tinkoff.ru` (тест); их библиотека и использует по умолчанию. В практике автора работал и `securepay.tbank.ru`, но в официальной документации он не упомянут — задаётся через `baseUrl`.
- **Подпись вебхука «Долями»** не реализована: алгоритм в публичной документации не описан.
- **Порядок ключей в подписи Т-Банка.** Документация говорит «по алфавиту»; библиотека сортирует по кодовым единицам. Для ключей из документированных примеров порядок совпадает с локальным, но для ключей с разным регистром на первом различающемся символе (`PayType` и `PaymentId`) на живом терминале это не проверялось.
- **Допущения:** округление копеек в позиции чека — половина вверх; `waiting_for_commit` — то же состояние, что `wait_for_commit` (в OpenAPI есть оба, в вебхуках только второй); `order.id` ≤ 30 символов взято со страницы «Тестовая заявка» (отключается `validate: false`); `404` от `info` означает «заказ не создан».
- **Таблицы параметров уведомлений** на странице Т-Банка не отдаются без JS, поэтому тип `TbankNotification` собран по примеру токена, образцам уведомлений и перечню полей в тексте; неизвестные поля сохраняются.
- **Расхождения внутри документации «Долями»:** страница «Тестовая заявка» называет `order.amount = items × price`, а OpenAPI и страница «Возврат» — `amount + prepaid_amount = Σ`; библиотека следует OpenAPI. Страница «Тестовая заявка» называет одну сеть для вебхуков, страница «Webhooks» — три; используются три.
- Значения `tax`, `payment_method` у «Долями» в OpenAPI не перечислены, поэтому не проверяются.
- Не реализовано. Т-Банк: 3DS-методы, привязка карт и покупатели, СБП / T-Pay / SberPay / Mir Pay, `SendClosingReceipt`, маркетплейс (`Shops`), `Charge`. «Долями»: `correction`, QR-настройки, `aggregator_merchant`, демо-сценарии (`create_demo`, `payment-fail`, `reject` — они описаны на странице, но параметров нет в OpenAPI).

## Лицензия

[MIT](LICENSE), © 2026 Artem Svinoboev.

<details>
<summary>English</summary>

## tbank-dolyame-node

A typed, zero-dependency Node.js (>= 20, ESM, TypeScript strict) client for **T-Bank internet acquiring (EACQ API v2)** and the **Dolyame partner API**, written around the pitfalls that break real integrations. It is **not an official SDK** and has **not been run against a live terminal or a live Dolyame account**; it was built from the public documentation and tested against local stubs.

**What it handles**

- **Request token** per the docs (root-level scalars + `Password`, sorted, concatenated, SHA-256; nested `Receipt`/`DATA` excluded; booleans as `"true"`/`"false"`). Both vectors published in the docs are reproduced byte for byte. Keys are sorted by code unit, not by locale.
- **`HTTP 200` + `Success: false`.** Methods return `{ ok: true, data } | { ok: false, error }` with a typed `TbankError` (`errorCode`, `bankMessage`, `details`); `unwrap()` turns a failure back into an exception. Invalid input throws `ValidationError`, network/TLS problems throw `TransportError` (with `outcomeUnknown`), garbage responses throw `ProtocolError`.
- **Notifications.** `verifyNotification` / `parseNotification` with a constant-time comparison; Express 5 and plain `node:http` examples (both exercised by tests); answer exactly `OK` only after the event has been handled.
- **54-FZ receipts.** `buildReceipt` / `validateReceipt`: integer kopecks, item sum must equal `Amount`, `Price x Quantity = Amount`, `Taxation`/`Tax`/`PaymentMethod`/`PaymentObject` enums (cross-checked against the OpenAPI file by script), FFD 1.05 and 1.2 rules, agent and marking fields.
- **Russian root CA.** Node's bundled store lacks the "Russian Trusted Root CA", which breaks TLS to hosts that chain to it (even `developer.tbank.ru` failed in the system `curl` on macOS when checked on 2026-10-04). The package ships the public root (`certs/russian-trusted-root-ca.pem`, valid until 2032-02-27) and `createRussianTrustAgent()`, which **adds** it to `tls.rootCertificates` instead of replacing them. SHA-256 fingerprint: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`; verify it against <https://www.gosuslugi.ru/crt> or <https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer> (pinned in `test/tls.test.ts`).
- **Dolyame.** `create`, `info`, `commit`, `cancel`, `refund`, `completeDelivery` with mTLS (client cert + key), Basic auth and `X-Correlation-ID` (UUID v4); a documented status lifecycle as a small map (`DOLYAME_TRANSITIONS`, `shouldApplyDolyameStatus` for duplicate/out-of-order webhooks); webhook parsing, source-IP check and verification through `info`. Without a client certificate the host answers with an HTML `400 No required SSL certificate was sent`, which surfaces as a `ProtocolError` with a hint.
- **Retries only where safe.** `getState`, `checkOrder`, `cancel` with `ExternalRequestId` and Dolyame `info` are retried (network errors, timeouts, 429, 5xx, with backoff and jitter); `init`, `confirm`, `create`, `commit`, ... are single attempts. Configurable base URLs, `AbortController` timeouts and a pluggable `transport`.
- **Payment-page allow-list pitfall.** The `PaymentURL`/`link` host is response data, may differ from the API host and may change; a hard-coded single-domain allow-list silently turns a successful payment into "no link". `isAllowedPaymentUrl` is a small guard for config-driven allow-lists.

**Install:** `npm install github:KapaSique/tbank-dolyame-node`. **Scripts:** `npm run typecheck`, `npm test` (123 tests, no skips; local `node:http` bank, real TLS/mTLS handshakes using throwaway `openssl` certificates), `npm run build`. Tested on Node 20, 22 and 26.

**Limitations.** Dolyame's webhook `signature` is not verified because the public docs do not say what is hashed (use the IP check plus `info`). Defaults use the hosts listed in the official docs (`securepay.tinkoff.ru`, `rest-api-test.tinkoff.ru`, `partner.dolyame.ru`); `securepay.tbank.ru` worked in the author's experience but is not in the docs (override `baseUrl`). Rounding half-up for fractional receipt quantities, treating `waiting_for_commit` as `wait_for_commit` and the 30-character `order.id` limit are assumptions. 3DS/card-binding/SBP/T-Pay methods, `SendClosingReceipt`, marketplace `Shops`, Dolyame `correction` and QR settings are not implemented. See the Russian "Что проверено, а что нет" section for the full list.

</details>
