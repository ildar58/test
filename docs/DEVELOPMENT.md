# Локальная разработка

Пошагово от `git clone` до просмотра записи. Покрывает типовые грабли,
которые поймаешь на свежей машине.

Архитектура — в [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. Что нужно

| Инструмент | Минимум | Рекомендуется | Зачем |
|------------|---------|---------------|-------|
| Node | 20 | **24 LTS** | `engines.node` проекта `>=20`, но `pnpm` v11 требует Node ≥ 22. Если только Node 20 — даунгрейди pnpm или апгрейди Node. |
| pnpm | 9 | **11.x** | Workspace и lockfile рассчитаны на современный pnpm. |
| Docker Desktop | запущен | свежий | Для прокси-стека и E2E. |
| macOS / Linux | — | macOS arm64 / Linux x64 | Тестировалось на macOS arm64; на Linux x64 должно работать. Windows не тестировался. |

Если у тебя `nvm`, переключи перед всем остальным:

```bash
nvm use 24
```

---

## 2. Установка + первая сборка

```bash
git clone <repo>
cd rrweb-testing
pnpm install
pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

Последняя строка копирует свежесобранный IIFE-бандл туда, где nginx
будет его раздавать. Это сделано вручную намеренно — можешь принести
свой бандл.

---

## 3. Запуск полного стека

```bash
pnpm dev:proxy
```

Поднимает три контейнера через Docker Compose:

- **nginx** на `localhost:8080` — раздаёт демо-приложение с
  встроенным рекордером, проксирует `/auth/*`, `/s/`, `/sessions`
  в ingestion.
- **demo-app** — статический nginx, раздаёт [`demo-app/index.html`](../demo-app/index.html).
- **ingestion** — Node-стаб из [`ingestion/`](../ingestion).

Открой <http://localhost:8080>:

1. Страница загрузилась с панелью Auth, статус «logged out».
2. Введи `alice` / `alice` (или `bob`/`bob`), жми **Log in**. Статус
   станет «logged in».
3. Пощёлкай по странице — поля input'ов, кнопки. Рекордер захватывает.
4. Через ~2 секунды увидишь `POST /s/` в network-вкладке с 200.
5. Жми **Log out**. Статус flip'нется обратно, `/s/`-трафик прекратится.

Что сохранилось: `curl http://localhost:8080/sessions | jq`.
Воспроизведение: открой `http://localhost:8081` и вставь session_id.
Остановить стек: `Ctrl+C`, потом
`docker compose -f proxy/docker-compose.yml down`.

---

## 4. Только ingestion (без Docker)

Полезно для бэкенд-изменений:

```bash
pnpm --filter @pam/ingestion dev
```

Гоняет `tsx watch src/server.ts` на `localhost:3001`. Hot-reload на
исходниках. Драйв через `curl`:

```bash
# Логин
curl -c /tmp/jar -X POST http://localhost:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"user":"alice","password":"alice"}'

# Залить батч
EVENTS=$(node -e "console.log(require('zlib').gzipSync(JSON.stringify([{type:0,timestamp:1,data:{}}])).toString('base64'))")
curl -b /tmp/jar -X POST http://localhost:3001/s/ \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$(uuidgen)\",\"batch_seq\":1,\"events_b64_gzip\":\"$EVENTS\"}"

# Список сессий
curl http://localhost:3001/sessions | jq
```

---

## 5. Просмотр записей

После работы в демо записи появляются в `ingestion/data/` **на хосте**
(благодаря bind-mount'у — раньше прятались внутри Docker volume).

```bash
ls ingestion/data/
# 8d551208-…jsonl
# 8d551208-…meta.json
```

Два способа посмотреть:

```bash
# 1. JSON-список через HTTP API
curl http://localhost:8080/sessions | jq

# 2. Реплеер в браузере
open http://localhost:8081   # или http://localhost:8080/replay/
```

---

## 6. Тесты

```bash
pnpm test           # unit + интеграционные (vitest), без Docker, ~2с
pnpm typecheck      # tsc --noEmit по всем пакетам
pnpm test:e2e       # Playwright + полный Docker-стек, ~40с
```

Unit-тесты покрывают SDK state machine, auth-модуль, transport
и ingestion-сервер. E2E гоняют настоящий Chromium
против живого Docker-стека — см. [`e2e/README.md`](../e2e/README.md).

---

## 7. Типичные проблемы

### «Docker is not running»

Запусти Docker Desktop и дождись, пока `docker info` пройдёт.
`pnpm test:e2e` авто-скипает variant-a, если Docker лежит.

### Playwright ругается на «Executable doesn't exist at .../chrome-headless-shell»

Это уже неактуальный вариант — `chromium-headless-shell` больше не
ставится. Используй Chrome for Testing (`npx @puppeteer/browsers install
chrome@stable`) и переменную `CHROME_EXECUTABLE` — в
[`e2e/playwright.config.ts`](../e2e/playwright.config.ts) уже есть
опт-ин под это.

Если `playwright install` падает с `proper-lockfile` ошибками — почисти
кэш и попробуй снова:

```bash
rm -rf ~/Library/Caches/ms-playwright   # macOS
pnpm --filter @pam/e2e exec playwright install chromium
```

### `pnpm install` падает на Node 20

`pnpm` v11 требует Node ≥ 22 (импортит `node:sqlite`). Либо:

- Апгрейд Node: `nvm use 24`.
- Либо пин старого pnpm: `corepack prepare pnpm@10.0.0 --activate`.

### Конфликты портов 8080 / 8081 / 3001

Что-то ещё на машине держит порт. `lsof -i :8080` покажет. Останови
или поменяй mapping в [`proxy/docker-compose.yml`](../proxy/docker-compose.yml).

### `ingestion/data/` файлы root-овые

Контейнер ingestion бежит как root, поэтому файлы на хосте имеют
root-овладельца. Используй `sudo` для удаления, либо `sudo chown -R
$USER ingestion/data/` после `docker compose down`.

### Запись не стартует после логина

В DevTools проверь:

1. На вкладке Console — не упал ли бандл при инициализации.
2. На вкладке Application → Cookies — обе ли cookie выставлены
   (`session` HttpOnly + `session_present` non-HttpOnly).
3. На вкладке Network — `recorder.iife.js` отдался 200? Если 404 —
   ты забыл скопировать бандл в `proxy/recorder-bundle/` после
   `pnpm build`.

SDK опрашивает маркер каждые `markerPollMs` (default 5 с). Если
залогинился меньше 5 с назад и нет `visibilitychange` / `focus` —
подожди тик.

### `appendBatch is not a function` / TypeScript-ошибки после pull

`pnpm install` ещё раз. Если не помогает — снеси `node_modules`:

```bash
pnpm -r exec rm -rf node_modules
rm -rf node_modules
pnpm install
```

---

## 8. Workflow при редактировании

| Что меняешь | Команда | После |
|-------------|---------|-------|
| `sdk/src/**` | `pnpm --filter @pam/web-session-recorder dev` (esbuild watch) | `cp sdk/dist/recorder.iife.js proxy/recorder-bundle/`, потом refresh страницы |
| `ingestion/src/**` | `pnpm --filter @pam/ingestion dev` (tsx watch) | Hot-reload |
| `demo-app/index.html` | ничего | Refresh страницы |
| `proxy/nginx.conf` | `docker compose -f proxy/docker-compose.yml restart nginx` | — |
| Тесты | `pnpm --filter @pam/web-session-recorder test:watch` и т.д. | — |

---

## 9. Где что искать

| Ищешь | Смотри |
|-------|--------|
| Как работает state machine | [`sdk/src/recorder.ts`](../sdk/src/recorder.ts) + [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Контракт auth-флоу | [`ARCHITECTURE.md §3-§6`](ARCHITECTURE.md#3-cookies) + [`ingestion/src/auth.ts`](../ingestion/src/auth.ts) |
| Что нужно для прода | [`PRODUCTION.md`](PRODUCTION.md) |
