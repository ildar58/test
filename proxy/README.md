# nginx proxy-стек

nginx стоит перед целевым приложением. Инжектит `recorder.iife.js` в
каждый HTML-ответ через `sub_filter`. Само приложение не меняется.

## Что нужно

- Docker + Docker Compose
- Собранный IIFE-бандл (см. `recorder-bundle/build.md`)

## Quick start

```bash
# 1. Собрать IIFE-бандл
cd sdk && pnpm install && pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

# 2. Поднять стек
cd proxy
docker compose up --build

# Целевое приложение (с инжектированным рекордером): http://localhost:8080
# Replayer admin: http://localhost:8081
```

## Ключевые решения в nginx-конфиге

| Строка | Зачем |
|--------|-------|
| `proxy_set_header Accept-Encoding ""` | Отключает upstream-gzip, чтобы `sub_filter` видел plain HTML |
| `sub_filter </head> ...` | Инжектит рекордер перед `</head>` — работает для всех страниц |
| `sub_filter_once on` | Инжект только один раз (защита от двойного инжекта, если `</head>` встречается в JS) |
| `location /_rec/` | Бандл рекордера отдаётся как статика, не проксируется — быстрее |
| `location /s/` | POST батча проксируется в ingestion |

## CSP-заметка

Если у целевого приложения строгий CSP — нужен per-request nonce.
Варианты:

1. nginx-plus: `set_secure_random_alphanum $nonce 32;`, потом вставлять
   nonce и в CSP-header, и в `<script>`-тег.
2. lua-nginx-module: `local nonce = require("resty.random").bytes(16, true)`.
3. Upstream-приложение: генерит nonce server-side, отдаёт через
   response-header, nginx читает через `$upstream_http_x_csp_nonce`.
