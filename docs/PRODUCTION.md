# Порт в продакшн

Что демо-стаб подменяет vs что должен делать настоящий Go-сервис.
Прочитай это, прежде чем направить продукт на этот код.

Архитектура «как сейчас» — в [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Ментальная модель: стаб vs продакшн

Рекордер, конфиг nginx, демо-страница и реплеер — **production-shaped**.
Они исходят из предположений о бэкенд-контракте — same-origin через
nginx, HttpOnly + marker cookies, opaque session token, `user_id`
выводится сервером — и эти предположения соответствуют design-спеке.

Node-сервис в [`ingestion/`](../ingestion) реализует **тот же контракт**
со stub-семантикой, поэтому recorder-цикл, lifecycle и e2e-тесты —
настоящие, но identity, persistence и security-hardening намеренно
упрощены. Список ниже — явный gap-анализ.

---

## 2. Auth и сессии

### Заменить хранилище юзеров

Сейчас: [`ingestion/src/auth.ts`](../ingestion/src/auth.ts) хардкодит
`alice` и `bob` с bcryptjs-хэшами, закоммиченными в репо. Массив `users`
типизирован как `ReadonlyArray<DemoUser>`.

Прод: интеграция с корпоративным identity provider (LDAP / SSO /
существующий auth-бэкенд, владеющий записями юзеров и хэшами паролей).
Контракт `/auth/login` должен принимать тот же шейп `{user, password}`
и эмитить те же две cookie — за этим уже свободно меняй реализацию
`verifyPassword`.

### Заменить session store

Сейчас: in-memory `Map<token, SessionEntry>` в
[`auth.ts`](../ingestion/src/auth.ts). Нет TTL, eviction'а, cap'а;
рестарт разлогинивает всех.

Прод:

- Persistent токены (Redis / Postgres / Keydb) — чтобы рестарт никого
  не разлогинивал.
- Абсолютный и idle TTL. По истечении `getSession` возвращает `null`
  → transport ловит 401 → state machine деактивируется.
- Cap на максимум сессий-на-юзера (defence in depth от token flooding'а).
- Аудит-лог выдачи и отзыва токенов.

### Использовать настоящий формат токена

Сейчас: 32-byte random hex token, opaque, без вложенных claim'ов.

Прод: либо опаковые токены (проще, требует lookup), либо short-lived
подписанные JWT с denylist'ом для ранней ревокации. Рекордеру всё равно —
он видит только значение cookie, которое трактует как opaque string.

### Добавить `Secure` к cookies

Сейчас: `httpOnly: true, sameSite: 'lax', path: '/'`. Без `Secure`,
потому что демо ходит по HTTP localhost.

Прод: добавить `secure: true` **обеим** `res.cookie`-вызовам в
[`ingestion/src/server.ts`](../ingestion/src/server.ts). Комментарии
`TODO(prod)` помечают точные строки. Как только этот флаг включён,
браузер откажется слать cookie по чистому HTTP — убедись, что HTTPS
терминируется на nginx.

### Затянуть CORS

Сейчас: `cors({ credentials: true })` reflect'ит request `Origin` для
любого вызывающего, с credentials включёнными.

Прод: пин'нить `origin` на список известных хостов фронтенда. CSRF-поза
сейчас опирается на (a) nginx, раздающий recorder + app + ingestion
same-origin, и (b) `SameSite=Lax`. Что-то, что ломает (a) — например,
отдельный домен для ingestion — требует настоящего CSRF-токена на
каждый state-changing запрос.

---

## 3. Известные уязвимости

Эти вещи поймал post-implementation security-review и **намеренно
зафиксированы здесь**, а не пофикшены в стабе:

### Path traversal в storage

**Файл:** [`ingestion/src/storage.ts:17`](../ingestion/src/storage.ts#L17)
**Severity:** High в продакшен-деплое.

`session_id` из тела запроса идёт прямо в
`path.join(dataDir(), sessionId + '.jsonl')` без валидации формата.
Аутентифицированный клиент может прислать `session_id: "../etc/cron.d/x"`
и писать вне data-директории.

Fix: валидировать `session_id` по UUID-формату в server-handler'е до
вызова `appendBatch`. Если оставляешь JSONL-на-диске в проде — ещё и
ассерт `path.resolve(file).startsWith(path.resolve(dataDir()) + path.sep)`
внутри `appendBatch` как defence in depth.

### Path traversal в GET /sessions/:id

**Файл:** [`ingestion/src/server.ts:78`](../ingestion/src/server.ts#L78)
**Severity:** High в продакшен-деплое.

`req.params.id` проходит ту же дорогу через `getSessionEvents`. Express
URL-decod'ит path-параметры, поэтому слэши `%2F` переживают
route-matcher и приземляются в `path.join` как traversal. Маршрут ещё и
без аутентификации (см. следующий пункт), так что read-примитив
доступен анонимным атакующим.

Fix: та же проверка UUID-формата.

### Читающие эндпоинты без auth

**Файл:** [`ingestion/src/server.ts:74,78`](../ingestion/src/server.ts#L74)
**Severity:** Critical в продакшен-деплое.

`GET /sessions` и `GET /sessions/:id` не проверяют auth никак. Дизайн-спека
[§4.3](superpowers/specs/2026-05-28-auth-gated-recording-design.md#43-go-service-contract)
требует «Admin-only role guard», но стаб его не реализовал. Nginx
выставляет `/sessions` на публичный 80 порт — анонимы могут листать
и скачивать все записи.

Fix: добавить middleware admin-роли на оба хендлера. Лучше всего —
Express middleware, который:

1. Читает `session` cookie через тот же `getSession` lookup.
2. Проверяет, что username принадлежит admin-роли.
3. Возвращает 401 / 403 иначе.

В nginx — рассмотри удаление блока `location /sessions` с публичного
порта 80, оставив reads только на admin-порту (сейчас `8081`).

---

## 4. Хранилище

### Заменить JSONL на диске

Сейчас: каждый батч append'ится JSON-строкой в `data/<sid>.jsonl`,
с метаданными в `data/<sid>.meta.json`. Хранится в bind-mount'е
`ingestion/data/` на хосте (раньше был именованный Docker-volume).

Прод:

- Выбрать настоящий store. ClickHouse для аналитики + S3 для блобов —
  один вариант; чистый S3 с ключом `<user>/<session_id>/<batch_seq>` —
  проще для replay-only нагрузки.
- Сделать `appendBatch` идемпотентным по `(session_id, batch_seq)` —
  чтобы сетевой ретрай не складывал события дважды.
- Добавить retention. Сессии не должны жить вечно; выбери TTL,
  согласованный с DPIA / GDPR.
- Шифровать at-rest.

### Сделать реплеер масштабируемым

Реплеер в [`replayer/index.html`](../replayer/index.html) дёргает
`GET /sessions/:id` и тащит полный поток событий в память. Для коротких
сессий нормально (rrweb хорошо жмётся), но для часовых записей нужны
chunk'и или пагинированное чтение.

### Реплеер замаунчен (исправлено)

Реплеер теперь bind-mount'ится из `replayer/` в контейнер ingestion
через [`proxy/docker-compose.yml`](../proxy/docker-compose.yml).
Маршрут доступен на `http://localhost:8081/` в локальном стеке и на
`http://localhost:8080/replay/` через основной порт. Admin-auth gap на
`GET /sessions[/:id]` всё ещё отслеживается выше.

---

## 5. Hardening рекордера

Бандл рекордера уже production-shaped, но несколько вещей намеренно
вне MVP:

- **Нет `MutationThrottler`.** rrweb 2.0-alpha может крашить на
  патологических DOM (глубокие React-деревья, SVG-анимации). У форка
  PostHog есть throttler + max-depth guard — порти их до прода.
- **Нет network-plugin'а.** `fetch`/`XHR` не записываются. Если будешь
  добавлять — **обязательно** редактируй deny-list по `Authorization`,
  `Cookie`, `x-api-key` и прочим заголовкам с секретами. См. PostHog
  `network-plugin.ts` для референса.
- **Нет автоматизации CSP-nonce.** Конфиг nginx инжектит inline
  `<script>`, который зовёт `init({...})`. При строгом CSP без inline
  нужны per-request nonce'ы:
  - `nginx-plus` с `set_secure_random_alphanum`.
  - `lua-nginx-module` с `resty.random`.
  - Upstream-приложение генерит nonce server-side, отдаёт через
    response-header, nginx читает `$upstream_http_x_csp_nonce`.
- **Cross-origin iframe'ы не записываются.** По умолчанию намеренно.
  Per-iframe opt-in через `recordCrossOriginIframes: true` требует
  инжектить бандл и в каждом cross-origin'е iframe тоже.

---

## 6. Video pipeline

`tools/video/` — CLI для экспорта сессии в `.webm`. Сейчас он лежит
рядом с проектом и работает локально; чтобы вынести в прод-инструмент
(батч-конвертер, GET endpoint), нужно:

### Браузер и ffmpeg в окружении

Сейчас CLI авто-находит Chrome for Testing под `~/chrome/` (от
`npx @puppeteer/browsers install chrome@stable`) или берёт путь из
`CHROME_EXECUTABLE`. В контейнерном окружении: либо ставить Chrome в
Docker-образ, либо использовать готовый образ `mcr.microsoft.com/playwright`.

На macOS arm64 встроенный Playwright'ом `ffmpeg-mac` приходит без
подписи и убивается Gatekeeper'ом — CLI содержит «auto-heal»: при
старте пробует запустить `ffmpeg-mac -version`, если падает — копирует
системный ffmpeg (`brew install ffmpeg`) в кэш Playwright. В Linux-контейнере
эта проблема не возникает, авто-fix просто ничего не делает.

### Превратить в server-side endpoint

Сейчас CLI зовётся вручную из локального cwd. Чтобы сделать `GET
/sessions/:id/video`:

1. Положи `transformToVideo` логику в общий модуль (вынести из export.ts).
2. Поставь worker (BullMQ / Inngest / Temporal) — конвертация занимает
   2-3 секунды на минуту сессии и блокирует CPU.
3. Сохраняй `.webm` в тот же storage, что и `.jsonl`.
4. Не забудь добавить admin-guard, тот же, что для `/sessions[/:id]`.

### Альтернативный пайплайн

Если хочешь MP4 вместо .webm:

```bash
ffmpeg -i <sid>.webm -c:v libx264 -preset fast <sid>.mp4
```

Можно встроить пост-шаг в `tools/video/src/export.ts`, если стейкхолдеры
требуют MP4. В демо это YAGNI.

---

## 7. Операционные вопросы

### Multi-tenancy

Рекордер + ingestion-дизайн рассчитан на single tenant. Multi-tenant
деплои требуют:

- Tenant id в cookie (или выводится из claim'ов auth-токена).
- Tenant id как часть storage-ключа.
- Per-tenant rate-limit'ы + storage-квоты.
- Tenant-isolated admin-role guards.

### Rate limiting

В стабе нет. В проде нужны лимиты на:

- `POST /auth/login` per IP и per username (lockout после N failed
  попыток).
- `POST /s/` per session_id (cap на batches-per-second и общий лимит
  на сессию).
- `GET /sessions/:id` per admin-role (replay-эндпоинт тяжёлый).

### Observability

В стабе ноль. Минимум:

- Структурированные логи запросов (без тел — события содержат PII даже
  замаскированные).
- Метрики SDK через существующий `onUnauthorized` / cool-down путь:
  сколько сессий уходит в cool-down в час — расскажет о cookie-expiry
  гонках.
- Health-endpoint на ingestion-сервисе.

---

## 8. Migration checklist

Если портируешь сегодняшний стаб в настоящий Go-сервис, разумный
порядок такой:

1. ✅ Recorder, nginx, demo, e2e — уже сделано, ничего менять не нужно.
2. **Реализовать Go auth-бэкенд** — матчить wire-контракт в
   [`ARCHITECTURE.md`](ARCHITECTURE.md#6-wire-формат). Добавить
   `Secure`-флаг cookie и изменения cookie-store из списка выше.
3. **Реализовать Go ingestion-хендлер** — тот же контракт `POST /s/`,
   но с UUID-валидацией `session_id` и настоящим storage-бэкендом.
4. **Добавить admin-role guard** на читающие эндпоинты.
5. **Добавить observability + rate limiting + аудит-логи.**
6. Направить nginx на Go-сервис (заменить `ingestion` upstream в
   [`proxy/nginx.conf`](../proxy/nginx.conf)).
7. Удалить Node `ingestion/`-пакет — как только Go-сервис раздаёт тот
   же контракт, стаб не нужен. Рекордер не меняется.

Wire-формат и lifecycle рекордера специально спроектированы так, чтобы
шаг 7 был drop-in заменой: пока Go-сервис эмитит те же две cookie и
гейтит `POST /s/`, SDK ничего не заметит.
