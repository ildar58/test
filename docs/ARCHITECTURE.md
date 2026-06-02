# Архитектура

Как рекордер, nginx и ingestion-сервис работают вместе. Прочитай это **до**
изменений в SDK или auth-флоу.

---

## 1. Цели и ограничения

Рекордер должен:

1. **Не требовать изменений в хост-приложении.** Никаких правок в Angular SPA,
   сидящей за nginx. Хостом может быть legacy-приложение, которое никто не
   хочет трогать.
2. **Записывать только после аутентификации.** Pre-login страницы (форма
   логина, восстановление пароля) никогда не должны попадать в записи.
3. **Привязывать идентичность к серверу, а не к клиенту.** В проде auth
   использует HttpOnly cookie — браузер не даёт её прочитать, и SDK даже
   не пытается. Сервер выводит `user_id` из cookie на каждый батч.
4. **Переживать обычную SPA-навигацию.** Логин на Angular-роуте должен
   активировать рекордер без full page reload.
5. **Корректно вести себя при типичных сбоях.** Скачки сети, истечение
   auth-cookie в середине сессии, перезагрузки страницы пока залогинен,
   смена фокуса вкладки — всё должно давать осмысленный результат, а не
   крашить и не спамить сервер.

---

## 2. Компоненты

| Компонент | Ответственность | Источники |
|-----------|-----------------|-----------|
| **nginx** | Reverse-прокси. Вставляет `<script src="/_rec/recorder.iife.js">` в каждый HTML-ответ через `sub_filter`. Маршрутизирует `/auth/*`, `/s/`, `/sessions` в ingestion. | [`proxy/nginx.conf`](../proxy/nginx.conf) |
| **Recorder SDK** | Грузится как IIFE-бандл. Следит за cookie-маркером, гоняет state machine IDLE/ACTIVE, запускает rrweb, батчит события, шлёт с credentials. | [`sdk/src`](../sdk/src) |
| **Ingestion-сервис** | Cookie-gated приёмник батчей + auth-стаб. В проде — Go-сервис; в репо — Express-стаб с bcryptjs и in-memory store сессий. | [`ingestion/src`](../ingestion/src) |
| **Демо-приложение** | Простая HTML-страница за nginx для локального демо и e2e. Имеет панель Auth, которая зовёт стаб. | [`demo-app/index.html`](../demo-app/index.html) |
| **Реплеер** | Однофайловая HTML-страница, грузит `rrweb-player` из CDN и воспроизводит сессию по id. | [`replayer/index.html`](../replayer/index.html) |
| **Video CLI** | TypeScript-инструмент: декодирует JSONL, рендерит в реплеере через Playwright + `recordVideo`, выдаёт `.webm`. | [`tools/video`](../tools/video) |

---

## 3. Cookies

Auth-стейт несут две cookie:

| Cookie | HttpOnly | Кто ставит | Кто читает | Зачем |
|--------|----------|------------|------------|-------|
| `session` | **да** | Бэкенд на `POST /auth/login`; снимается на `/auth/logout` | Только сервер (браузер шлёт автоматически с `credentials: 'include'`) | Настоящий auth-токен. В демо-стабе — random 32-byte hex token в in-memory `Map`; в проде это будет JWT / opaque token с криптоверификацией. |
| `session_present` | **нет** | Тот же login-response; снимается на logout | JS в рекордере через `document.cookie` | Boolean-маркер присутствия. Говорит SDK «юзер залогинен» без раскрытия секрета. Значение всегда `1`, если выставлен. |

Разделение существует потому что **HttpOnly cookies невидимы для JavaScript
по дизайну**. Без компаньон-маркера SDK не знает, что он аутентифицирован,
пока следующий батч не вернёт 200 или 401 — а нам надо, чтобы state machine
активировалась *до того, как* пошлёт хоть одно событие.

Обе cookie используют `SameSite=Lax; Path=/`. В проде нужно добавить
`Secure` после того, как HTTPS терминируется на nginx (демо ходит по
HTTP localhost).

---

## 4. State machine рекордера

```
                    маркер cookie замечен
              ┌─────────────────────────────────┐
              │                                  │
              ▼                                  │
        ┌──────────┐  маркер замечен    ┌──────────────┐
        │   IDLE   │ ─────────────────▶ │    ACTIVE    │
        │  (polls) │                    │  (записывает)│
        └──────────┘ ◀───────────────── └──────────────┘
              │      маркер исчез              │
              │      или батч вернул 401       │
              │                                │
              │  stop()                        │  stop()
              ▼                                ▼
        ┌──────────┐                    ┌──────────────┐
        │ STOPPED  │ ◀───────────────── │   STOPPED    │
        └──────────┘                    └──────────────┘
```

Состояния в собственности класса `Recorder` из [`sdk/src/recorder.ts`](../sdk/src/recorder.ts).

### Триггеры

SDK наблюдает за маркером тремя способами:

1. **Синхронный чек на `init()`** — покрывает случай page-reload, когда
   юзер был залогинен в момент загрузки страницы. Без этого edge-detection
   watcher'а никогда не сработала бы, потому что transition нет.
2. **`setInterval`-poll** каждые `markerPollMs` (default 5 с).
3. **Event-listeners** на `visibilitychange` и `focus` — даёт быструю
   реакцию, когда юзер вернулся во вкладку.

### IDLE → ACTIVE

1. Сгенерировать или переиспользовать UUID `session_id`.
2. Положить его в `sessionStorage['_pam_sid']` для reload-continuity.
3. Создать свежий `Transport`, подключить колбэки `onAuthorized`/`onUnauthorized`.
4. Запустить `rrweb.record({ ... })` с masking-конфигом.

### ACTIVE → IDLE

Триггерится либо исчезновением маркера, либо возвратом 401 на батч. SDK:

1. Зовёт rrweb stop handle.
2. Останавливает `Transport` (чистит flush-interval, снимает listeners).
3. Дропает in-memory буфер (события, захваченные, но ещё не отправленные,
   отбрасываются — это намеренно, чтобы ограничить, сколько pre-logout
   активности может попасть в storage).
4. Чистит `sessionStorage['_pam_sid']` — следующая ACTIVE-фаза начинает
   с нового `session_id`.

### Cool-down по 401

После **N подряд** батчей, возвращающих 401 (default `unauthorizedThreshold = 3`),
SDK уходит в cool-down на `unauthorizedCooldownMs` (default 60 с) — в это
время `tryActivate` подавляется, даже если маркер на месте. Счётчик
сбрасывается на следующем успешном батче (200 OK), а **не** на
re-activation — так транзиентные 401'ы не накапливаются в фальшивый
cool-down.

### Reload-continuity

Если юзер делает reload, будучи в ACTIVE, рекордер инжектится заново и
`init()` бежит снова. Поскольку `sessionStorage['_pam_sid']` переживает
reload, SDK переиспользует UUID — сервер append'ит в тот же
`<session_id>.jsonl`, реплеер видит одну непрерывную сессию.

---

## 5. Поток данных

### Логин

```
Браузер                    nginx                  ingestion (Go в проде)
   │                         │                              │
   │ POST /auth/login        │                              │
   │  { user, password }     │                              │
   ├────────────────────────▶│                              │
   │                         │ POST /auth/login             │
   │                         ├─────────────────────────────▶│
   │                         │                              │ bcrypt.compare
   │                         │                              │ createSession(user)
   │                         │ 200                          │
   │                         │ Set-Cookie:                  │
   │                         │   session=<token> HttpOnly   │
   │                         │   session_present=1          │
   │                         │◀─────────────────────────────┤
   │ 200 + cookies           │                              │
   │◀────────────────────────┤                              │
   │                                                        │
   │ marker watcher видит session_present=1                 │
   │ → Recorder IDLE → ACTIVE                               │
   │ → rrweb начинает захватывать                           │
```

### Запись

```
Браузер                                          ingestion
   │                                                  │
   │ rrweb emit → Transport.push → буфер             │
   │ (flush каждые flushIntervalMs = 2 с)            │
   │                                                  │
   │ POST /s/                                         │
   │  Cookie: session=<token>; session_present=1      │
   │  body: {session_id, batch_seq, events_b64_gzip}  │
   ├─────────────────────────────────────────────────▶│
   │                                                  │ getSession(token)
   │                                                  │ → entry.username
   │                                                  │ appendBatch(batch, username)
   │                                                  │ data/<sid>.jsonl
   │ 200                                              │
   │◀─────────────────────────────────────────────────┤
   │                                                  │
   │ Transport.onAuthorized() сбрасывает счётчик 401  │
```

### Logout

```
Браузер                                          ingestion
   │                                                  │
   │ POST /auth/logout                                │
   ├─────────────────────────────────────────────────▶│
   │                                                  │ destroySession(token)
   │                                                  │ Set-Cookie: …; Max-Age=0
   │ 200, cookies очищены                             │
   │◀─────────────────────────────────────────────────┤
   │                                                  │
   │ marker watcher видит, что session_present ушёл   │
   │ → Recorder ACTIVE → IDLE                         │
   │ → rrweb стопает, in-flight буфер дропается       │
```

Если в момент logout батч уже в полёте — он может приземлиться в storage
*после* того, как cookie очищена. Это нормально — он несёт ту cookie, что
была на момент постановки запроса в очередь, и токен ещё ведёт к юзеру в
in-memory store, пока logout-запрос не отработал. Как только
`destroySession` отработал — любое дальнейшее использование cookie
вернёт 401, и SDK уйдёт в IDLE, если ещё не ушёл.

---

## 6. Wire-формат

### `POST /auth/login`

Request: `{ user: string, password: string }`
Success: `200 { success: true, user: string }`
Failure: `401 { success: false, error: "invalid credentials" }`

Одинаковый 401-шейп для отсутствующих полей, неизвестного юзера и
неверного пароля — bcrypt compare бежит даже для unknown user, чтобы
тайминг логина не утечкал существование юзера.

### `POST /auth/logout`

Request body: игнорируется.
Response: `200 { success: true }` (всегда — destroy идемпотентен).

### `POST /s/`

Headers: `Cookie: session=<token>` обязателен.
Body:

```ts
{
  session_id: string;        // UUID, генерируется SDK
  batch_seq: number;         // 1-based, монотонно растёт в рамках одной session_id
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

Success: `200 { success: true }`
401: `{ success: false, error: "unauthorized" }` — нет session-cookie или её
значение не лежит в in-memory store.
400: `{ success: false, error: "Missing required fields" }`.

`user_id` никогда не в wire-формате. Сервер выводит его через
`getSession(req.cookies.session).username` и сохраняет в
`data/<session_id>.meta.json`.

### `GET /sessions`

Возвращает метаданные всех сессий. **Сейчас без аутентификации** — см.
[`docs/PRODUCTION.md`](PRODUCTION.md#читающие-эндпоинты-без-auth).

### `GET /sessions/:id`

Возвращает декодированный массив событий для одной сессии. Та же auth-дыра.
`:id` сейчас не валидируется на формат UUID — см.
[`docs/PRODUCTION.md`](PRODUCTION.md#path-traversal).

---

## 7. Расклад файловой системы

Ingestion-стаб хранит всё под `data/` (bind-mount в compose-стеке —
лежит прямо в `./ingestion/data/` на хосте; в `pnpm dev:ingestion` тоже там же):

```
ingestion/data/
├── 8d551208-2474-4bf7-8b36-f375e09b2fd2.jsonl       # одна строка на батч
├── 8d551208-2474-4bf7-8b36-f375e09b2fd2.meta.json   # метаданные сессии
└── 8d551208-2474-4bf7-8b36-f375e09b2fd2.webm        # (опц.) экспорт через pnpm video
```

Каждая строка `.jsonl` — это сырой батч, как его прислал SDK: `session_id`,
`batch_seq`, gzip+base64 события. Реплеер конкатенирует события из каждой
строки по порядку, восстанавливая полный поток.

Шейп `.meta.json`:

```json
{
  "session_id": "8d551208-…",
  "user_id": "alice",
  "started_at": "2026-05-28T02:29:48.951Z",
  "last_batch_at": "2026-05-28T02:29:50.947Z",
  "batch_count": 2
}
```

`user_id` пишется на первом батче и намеренно **не** обновляется
последующими — одна сессия принадлежит одному юзеру. Если другой юзер
аутентифицируется на той же вкладке, генерируется новый `session_id`,
поэтому межюзерное загрязнение одного файла структурно невозможно.

---

## 8. Video pipeline (pnpm video)

`tools/video/` — отдельный CLI экспорта сессии в `.webm`:

```
.jsonl → decodeJsonl() → events[]
                            │
                            ▼
                  HTML с rrweb-player
                            │
                            ▼
       Playwright (Chrome for Testing)
       + newContext({ recordVideo })
                            │
                            ▼
                  <sid>.webm в ingestion/data/
```

CLI не зовёт `rrvideo` (тот хардкодит `chromium.launch()` без
`executablePath`, что несовместимо с современной headless-моделью
Playwright). Вместо этого CLI:

1. Декодирует JSONL через тестированную утилиту `decode.ts`.
2. Читает `rrweb-player` UMD и CSS прямо из `node_modules`.
3. Собирает HTML с inline-events и `Player({ events, ... })`.
4. Запускает `chromium.launch({ executablePath, headless: true })`,
   где `executablePath` — это Chrome for Testing из `~/chrome/` или
   из env-переменной `CHROME_EXECUTABLE`.
5. Создаёт context с `recordVideo` → играет события → ждёт callback
   `onReplayFinish` (или timeout-фоллбэк) → закрывает context →
   получает `.webm`.

**macOS-специфический auto-heal:** Playwright ставит `ffmpeg-mac` без
подписи, Gatekeeper его убивает. CLI пробует запустить его при старте;
если не работает — копирует системный ffmpeg (`brew install ffmpeg`)
поверх него один раз. Подробности — в
[`docs/PRODUCTION.md`](PRODUCTION.md#video-pipeline).

---

## 9. Почему нет nightly cleanup, БД, sampling'а?

Это всё production-concerns; здесь учебная реализация. Gap-анализ — в
[`docs/PRODUCTION.md`](PRODUCTION.md).
