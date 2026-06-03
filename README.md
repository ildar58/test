# @pam/web-session-recorder

Рекордер браузерных сессий поверх [rrweb](https://github.com/rrweb-io/rrweb).
**Reverse-прокси на nginx** вставляет рекордер в каждый HTML-ответ — приложение
не нужно править. Запись **гейтится по аутентификации**: рекордер сидит в idle,
пока бэкенд не выставит маркер-cookie на логине, потом захватывает DOM-мутации
и пользовательские действия и шлёт батчи в ingestion-сервис.

Рекордер, nginx, демо-приложение и реплеер для тестирования.
Ingestion-сервис — Node-реализация auth и приёма батчей.

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
                    │  Node ingestion (Express)    │
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

---

## Просмотр записей

Записи лежат в `ingestion/data/` на хосте — один файл `<session_id>.jsonl`
(события) и один `<session_id>.meta.json` (юзер, таймстампы, счётчик батчей)
на каждую сессию. Два способа их посмотреть:

```bash
# 1. Список сессий через HTTP API
curl http://localhost:8080/sessions | jq

# 2. Воспроизвести сессию в браузерном реплеере
open http://localhost:8081
# (возьми session_id из списка выше, вставь в поле ввода)
```

---

## Структура репозитория

| Путь | Что это |
|------|---------|
| [`sdk/`](sdk) | Исходники IIFE-бандла рекордера на TypeScript. Внутренний пакет; в npm не публикуется. |
| [`ingestion/`](ingestion) | Express-сервис auth/ingestion (в проде заменяется на Go-сервис). |
| [`proxy/`](proxy) | Конфиг nginx + Docker Compose локального стека. |
| [`demo-app/`](demo-app) | Минимальное HTML-приложение, которое сидит за nginx как «продуктовое». |
| [`replayer/`](replayer) | Однофайловый реплеер на rrweb-player. |

---

## Конфиг рекордера

Sane privacy-first дефолты (зеркалят пресет PostHog):

| Опция | Default | Заметки |
|-------|---------|---------|
| `maskAllInputs` | `false` | Значения `<input>` по умолчанию не маскируются — иначе `<select>` и чекбоксы при воспроизведении теряют выбор. Пароли маскируются всегда (см. строку ниже); чувствительные блоки оборачивай в `rec-no-capture`. |
| `maskInputOptions` | `{ password: true }` | Пароли маскируются всегда, даже если `maskAllInputs: false`. |
| `blockClass` | `'rec-no-capture'` | Добавь этот класс к элементу — он и его поддерево полностью игнорируются. |
| `maskTextClass` | `'rec-mask'` | Добавь этот класс — текст содержимого заменится на `***`. |
| `ignoreClass` | `'rec-ignore-input'` | Добавь к input'у — печать в нём игнорируется. |
| `inlineStylesheet` | `true` | Инлайнить содержимое `<style>` в снапшот. |
| `collectFonts` | `false` | Не собирать веб-шрифты (приватность + размер). |
| `recordCrossOriginIframes` | `false` | Cross-origin iframe'ы не пишутся. |
| `markerCookieName` | `'session_present'` | Имя non-HttpOnly cookie-маркера, который бэкенд ставит на логине. |
| `sessionIdCookieName` | `'session_id'` | Имя non-HttpOnly cookie с id записи, который бэкенд минтит на логине. Рекордер читает её и шлёт как `session_id` в батчах. |
| `markerPollMs` | `1_000` | Фолбэк-период опроса маркера. Основная активация — мгновенная, по `cookieStore.onchange`; опрос (плюс реакция на `focus`/`visibilitychange`) страхует, если `cookieStore` недоступен. |
| `unauthorizedThreshold` | `3` | Сколько 401-induced деактиваций подряд до cool-down. |
| `unauthorizedCooldownMs` | `60_000` | Окно cool-down после достижения порога. |

Оверрайдятся через `data-*` атрибуты на инжектируемом теге `<script>` —
рекордер сам поднимается из `document.currentScript.dataset` при загрузке,
вызывать `init()` руками не нужно. Дефолтный nginx-сниппет ставит только
`data-endpoint="/s/"`; чтобы переопределить опцию, допиши соответствующий
`data-*` в `sub_filter` в [`proxy/nginx.conf`](proxy/nginx.conf) — например
`data-marker-poll-ms="2000"`, `data-session-id-cookie="rec_sid"` или
`data-mask-all-inputs="true"`.

---

## Wire-формат

Батчи, которые рекордер шлёт в `POST /s/`:

```ts
{
  session_id: string;        // минтится бэкендом на логине (cookie session_id), рекордер читает из неё
  batch_seq: number;         // монотонно растёт внутри сессии, начинается с 1
  events_b64_gzip: string;   // base64(gzip(JSON.stringify(eventWithTime[])))
}
```

Браузер шлёт auth-cookies автоматически (`credentials: 'include'`).
`user_id` **отсутствует** в wire-формате — сервер выводит его на сервере
из HttpOnly cookie `session`. Хранилище кладёт каждый батч строкой в
`data/<session_id>.jsonl`; реплеер восстанавливает, разжимая и
конкатенируя по порядку.

---

## Проверка типов

```bash
pnpm typecheck      # tsc --noEmit по всем пакетам
```

---

## Лицензия

MIT — см. [LICENSE](LICENSE).
