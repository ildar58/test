# @pam/web-session-recorder

Рекордер браузерных сессий поверх [rrweb](https://github.com/rrweb-io/rrweb).
**Reverse-прокси на nginx** вставляет рекордер в каждый HTML-ответ — приложение
не нужно править. Запись **гейтится по аутентификации**: рекордер сидит в idle,
пока бэкенд не выставит маркер-cookie на логине, потом захватывает DOM-мутации
и пользовательские действия и шлёт батчи в ingestion-сервис.

Это учебная / референс-реализация. Рекордер, nginx, демо-приложение и реплеер
сделаны в production-форме. Ingestion-сервис — это явный Node-стаб настоящего
Go-сервиса; что нужно изменить перед продом — см.
[`docs/PRODUCTION.md`](docs/PRODUCTION.md).

---

## Кратко

```
┌────────────────────────────────────────────────────────────────────────┐
│                            Браузер                                      │
│                                                                         │
│   Angular SPA (или любое HTML-приложение) с маршрутом /login            │
│   ┌──────────────────────────────────────────────────────────────┐      │
│   │ recorder.iife.js (инжектится nginx'ом в каждую страницу)      │      │
│   │   ┌─────────────────────────────────────────────────────┐    │      │
│   │   │ Idle, пока бэкенд не выставит cookie `session_present=1` │    │      │
│   │   │ → захватывает DOM-события                            │    │      │
│   │   │ → шлёт gzip+base64 батчи в /s/ с credentials         │    │      │
│   │   └─────────────────────────────────────────────────────┘    │      │
│   └──────────────────────────────────────────────────────────────┘      │
│   cookies: session (HttpOnly, opaque token), session_present (JS читает) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │       nginx             │
                       │  /  → upstream app      │
                       │       (sub_filter       │
                       │        вставляет скрипт)│
                       │  /_rec/ → static bundle │
                       │  /s/    → ingestion     │
                       │  /auth/ → ingestion     │
                       │  /sessions → ingestion  │
                       └──────────┬─────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Node ingestion (стаб)       │
                    │  POST /auth/login           │
                    │  POST /auth/logout          │
                    │  POST /s/    (cookie-gated) │
                    │  GET  /sessions[/:id]       │
                    │                             │
                    │  bcryptjs проверка пароля    │
                    │  in-memory store сессий      │
                    │  data/<sid>.jsonl на диске   │
                    └─────────────────────────────┘
```

Рекордер гейтится по non-HttpOnly cookie-маркеру `session_present=1`,
которую бэкенд ставит на логине. Настоящий auth-токен — это отдельная
HttpOnly cookie, JS до неё не дотягивается. Идентичность пользователя
выводится сервером из той самой HttpOnly cookie — она не появляется в
wire-формате.

См. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) для полного жизненного
цикла, state machine и того, что делает каждая cookie.

---

## Quick start

Нужны Docker, Node ≥ 20 (рекомендуется Node 24 LTS) и pnpm ≥ 9.

```bash
# 1. Установить зависимости workspace'а
pnpm install

# 2. Собрать бандл рекордера и положить его туда, где nginx его раздаёт
pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

# 3. Поднять полный стек (nginx + demo app + ingestion)
pnpm dev:proxy
```

Открой <http://localhost:8080>. Увидишь демо-страницу с панелью Auth.
Жми **Log in** (дефолтные креды `alice` / `alice`), пощёлкай по странице,
потом **Log out**.

Пошаговый dev-walkthrough с траблшутингом — в
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

---

## Просмотр записей

Записи лежат в `ingestion/data/` на хосте — один файл `<session_id>.jsonl`
(события) и один `<session_id>.meta.json` (юзер, таймстампы, счётчик батчей)
на каждую сессию. Три способа их посмотреть:

```bash
# 1. Список сессий через HTTP API
curl http://localhost:8080/sessions | jq

# 2. Воспроизвести сессию в браузерном реплеере
open http://localhost:8081
# (возьми session_id из списка выше, вставь в поле ввода)

# 3. Экспортировать сессию в .webm видеофайл
pnpm video <session_id>
# → ingestion/data/<session_id>.webm
```

Видеоэкспорт сделан через Playwright + `rrweb-player` напрямую (без бинарника
`rrvideo` — у него хардкод `chromium.launch()`, который не совместим с
современной headless-моделью Playwright). Требования:

- **Chrome for Testing** установлен через `npx @puppeteer/browsers install chrome@stable`
  (CLI авто-находит его в `~/chrome/`). Если у тебя бинарь лежит в другом
  месте — задай его путь в env-переменной `CHROME_EXECUTABLE`.
- **ffmpeg** в `$PATH` (например `brew install ffmpeg`) — на macOS arm64
  Playwright ставит unsigned бинарник `ffmpeg-mac`, и Gatekeeper его убивает.
  CLI авто-чинит это, копируя системный ffmpeg в кэш Playwright один раз на
  машину; без системного ffmpeg `recordVideo` не работает.

---

## Структура репозитория

| Путь | Что это |
|------|---------|
| [`sdk/`](sdk) | Исходники IIFE-бандла рекордера на TypeScript. Внутренний пакет; в npm не публикуется. |
| [`ingestion/`](ingestion) | Express-сервис — Node-стаб настоящего Go auth/ingestion сервиса. |
| [`proxy/`](proxy) | Конфиг nginx + Docker Compose локального стека. |
| [`demo-app/`](demo-app) | Минимальное HTML-приложение, которое сидит за nginx как «продуктовое». |
| [`replayer/`](replayer) | Однофайловый реплеер на rrweb-player. |
| [`e2e/`](e2e) | E2E-тесты на Playwright, гоняют полный Docker-стек. |
| [`tools/video/`](tools/video) | CLI экспорта сессии в `.webm` (Playwright + rrweb-player). |
| [`docs/`](docs) | Архитектура, руководство по разработке и production-чеклист. |

В каждом пакете свой README с подробностями. Начинать читать — отсюда.

---

## Карта документации

| Документ | Когда читать |
|----------|-------------|
| [`README.md`](README.md) | Ты здесь. Обзор, quick start. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Как работают cookies, state machine и поток данных в деталях. Прочитай **до** того, как лезть в SDK. |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Локальная разработка, hot-reload, траблшутинг Docker / Playwright / версий Node. Читать, когда что-то не запускается. |
| [`docs/PRODUCTION.md`](docs/PRODUCTION.md) | Что демо-стаб подменяет vs что должен делать настоящий Go-сервис; security-чеклист; deployment-поза. Читать, когда портируешь в прод. |
| [`e2e/README.md`](e2e/README.md) | Как устроены end-to-end тесты, как запускать локально и в CI. |

---

## Конфиг рекордера

Sane privacy-first дефолты (зеркалят пресет PostHog):

| Опция | Default | Заметки |
|-------|---------|---------|
| `maskAllInputs` | `true` | Все значения `<input>` маскируются в каждом событии. |
| `maskInputOptions` | `{ password: true }` | Пароли маскируются всегда, даже если `maskAllInputs: false`. |
| `blockClass` | `'rec-no-capture'` | Добавь этот класс к элементу — он и его поддерево полностью игнорируются. |
| `maskTextClass` | `'rec-mask'` | Добавь этот класс — текст содержимого заменится на `***`. |
| `ignoreClass` | `'rec-ignore-input'` | Добавь к input'у — печать в нём игнорируется. |
| `inlineStylesheet` | `true` | Инлайнить содержимое `<style>` в снапшот. |
| `collectFonts` | `false` | Не собирать веб-шрифты (приватность + размер). |
| `recordCrossOriginIframes` | `false` | Cross-origin iframe'ы не пишутся. |
| `markerCookieName` | `'session_present'` | Имя non-HttpOnly cookie-маркера, который бэкенд ставит на логине. |
| `markerPollMs` | `5_000` | Период опроса маркера (плюс реакция на `focus` и `visibilitychange`). |
| `unauthorizedThreshold` | `3` | Сколько 401-induced деактиваций подряд до cool-down. |
| `unauthorizedCooldownMs` | `60_000` | Окно cool-down после достижения порога. |

Передаются в `init({ ... })`. В nginx-варианте дефолтный сниппет зовёт
`init({ endpoint: '/s/' })` без оверрайдов — для оверрайда правь сниппет
в [`proxy/nginx.conf`](proxy/nginx.conf).

---

## Wire-формат

Батчи, которые рекордер шлёт в `POST /s/`:

```ts
{
  session_id: string;        // UUID, генерируется на клиенте на каждую ACTIVE-фазу
  batch_seq: number;         // монотонно растёт внутри сессии, начинается с 1
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

Браузер шлёт auth-cookies автоматически (`credentials: 'include'`).
`user_id` **отсутствует** в wire-формате — сервер выводит его на сервере
из HttpOnly cookie `session`. Хранилище кладёт каждый батч строкой в
`data/<session_id>.jsonl`; реплеер восстанавливает, разжимая и
конкатенируя по порядку.

См. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#6-wire-формат) — полный
контракт включая auth-эндпоинты.

---

## Тестирование

```bash
pnpm test           # unit + интеграционные (vitest) — быстро, гоняется в CI
pnpm test:e2e       # Playwright + полный Docker-стек — только локально
pnpm typecheck      # tsc --noEmit по всем пакетам
```

E2E требуют Docker. Playwright скачивает свой headless Chromium при первом
запуске; если у тебя уже стоит Chrome for Testing где-то ещё — смотри
[`e2e/README.md`](e2e/README.md#использование-уже-установленного-chrome)
про опт-ин через `CHROME_EXECUTABLE`.

Текущее покрытие: 33 SDK + 21 ingestion + 9 video unit/integration тестов,
плюс 5 сценариев Playwright, гоняющих полный Variant A lifecycle.

---

## Известные ограничения

Это **намеренные пробелы** в учебной реализации. Подробности — в
[`docs/PRODUCTION.md`](docs/PRODUCTION.md):

- **Path-traversal в `ingestion/src/storage.ts`** — `session_id` из тела
  запроса попадает в путь к файлу без валидации. Аутентифицированный
  атакующий может писать вне data-директории. Зафиксировано как
  follow-up.
- **`GET /sessions` и `GET /sessions/:id` не требуют auth** — design-спека
  требует admin-role guard. В Node-стабе не реализовано. Зафиксировано.
- **In-memory session store без TTL и cap** — рестарт сервера разлогинивает
  всех. ОК для стаба; в проде нужно eviction.
- **Демо-пароли закоммичены в виде plaintext-хэшей** — `alice/alice`,
  `bob/bob`. Весь массив `users` в `ingestion/src/auth.ts` — фикстура.

---

## Лицензия

MIT — см. [LICENSE](LICENSE).
