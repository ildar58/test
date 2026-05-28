# E2E-тесты — `@pam/e2e`

Тесты Playwright, гоняющие полный Docker-стек (nginx + demo + Node
ingestion стаб) и проверяющие end-to-end жизненный цикл рекордера.

Общий dev-гайд — в [`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).

---

## Что нужно

| Инструмент | Обязательно | Заметки |
|------------|-------------|---------|
| Node | ≥ 22 (LTS 24 рекомендуется) | pnpm v11 требует Node 22+. |
| pnpm | ≥ 11 | Workspace-менеджер. |
| Docker Desktop | запущен | Стек поднимается через `docker compose`. Тесты авто-скипаются, если Docker лежит. |
| Свободное место | ~500 МБ | Бинарники Chromium. |

---

## Первый раз

```bash
# Из корня репо: сборка + копирование бандла
pnpm install
pnpm build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

# Скачать headless Chromium для Playwright
pnpm --filter @pam/e2e exec playwright install chromium

# Запустить
pnpm test:e2e
```

Первый прогон ~40 секунд (поднятие Docker-стека + 5 сценариев).
Последующие — то же самое: стек поднимается заново для каждой
test-сессии.

---

## Что тестируется

Все пять сценариев в [`tests/variant-a.spec.ts`](tests/variant-a.spec.ts),
гоняют один и тот же docker-compose стек:

| Сценарий | Что проверяет |
|----------|---------------|
| recorder bundle is injected on every HTML response | `GET /` отдаёт HTML с `<script src="/_rec/recorder.iife.js">` |
| no `POST /s/` traffic while user is logged out | После загрузки страницы и печати в input'ы за 3.5с — ноль `/s/` запросов |
| login starts recording → batches appear in storage | После клика `#auth-login` `GET /sessions` показывает ≥1 сессию с `user_id=alice` и `batch_count > 0` |
| logout stops recording within poll interval | После клика `#auth-logout` + 7.5с grace — никакие `/s/` запросы не идут |
| logout → re-login produces two distinct session_ids for the same user | Полный цикл login → logout → login даёт ≥ 2 сессии с `user_id=alice` и разными `session_id` |

Login-сценарии используют `alice` / `alice` (дефолт в
[`demo-app/index.html`](../demo-app/index.html)).

---

## Запуск

```bash
pnpm test:e2e                                    # вся сюита, ~40с
pnpm --filter @pam/e2e exec playwright test \
  --grep "logout stops recording"                # одиночный тест
pnpm --filter @pam/e2e exec playwright test \
  --headed                                       # с видимым браузером
pnpm --filter @pam/e2e exec playwright show-report  # HTML-репорт последнего прогона
```

---

## Использование уже установленного Chrome

Если у тебя уже стоит Chrome for Testing через
`npx @puppeteer/browsers install chrome@stable` (или где угодно
ещё), направь Playwright на этот бинарник, не давая ему качать свой:

```bash
export CHROME_EXECUTABLE='/Users/you/chrome/mac_arm-149.0.7827.22/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
pnpm test:e2e
```

Опт-ин реализован в [`playwright.config.ts`](playwright.config.ts).
Если переменная не задана, Playwright использует свой
`chromium_headless_shell` из кэша. **Задавай только если уверен, что
файл по этому пути есть** — неверный путь даёт opaque-ошибку
«Executable doesn't exist» на каждом тесте.

> **Заметка:** Playwright постепенно убирает `chromium-headless-shell`
> как отдельный вариант. Если получаешь «doesn't exist» после
> `playwright install chromium`, попробуй Chrome for Testing через
> `CHROME_EXECUTABLE` — это самый надёжный путь сегодня.

---

## Тест-инфраструктура

```
e2e/
├── helpers/
│   └── docker-stack.ts      — docker compose up -d / health check / down
├── tests/
│   └── variant-a.spec.ts    — пять сценариев
├── playwright.config.ts     — проекты, ретраи, опт-ин CHROME_EXECUTABLE
└── package.json
```

Helper `startDockerStack` из `beforeAll`:

1. Запускает `docker info`, авто-`test.skip` если Docker лежит.
2. Запускает `docker compose -f proxy/docker-compose.yml up -d`.
3. Опрашивает `http://localhost:8080/`, пока не ответит.
4. Возвращает handle с `stop()`, который делает `docker compose down`.

`afterAll` зовёт `stop()` — сюита ничего за собой не оставляет.

---

## Что НЕ тестируется

Намеренные gap'ы:

- **Точность воспроизведения.** Нет assertion'а, что записанные события
  визуально корректно проигрываются через реплеер. Ручная проверка.
- **Кроссбраузерность.** Только Chromium.
- **Mobile viewport.** Не покрыто.
- **Длинные сессии.** Нет сценария с > 5 батчами на сессию.
- **Edge-кейсы аутентификации.** Wrong-password, lockout, expired-token
  mid-recording — покрыты ingestion vitest-сюитой, не e2e.
- **Variant B (npm SDK consumer).** Удалён в коммите
  [5b6a751](.) — поддерживается и тестируется только Variant A
  (nginx-инжект).

---

## Траблшутинг

| Симптом | Причина |
|---------|---------|
| Все тесты `test.skip`'нуты | Docker Desktop не запущен. |
| «Executable doesn't exist at .../chrome-headless-shell» | Не было `playwright install chromium`, либо `CHROME_EXECUTABLE` указывает на несуществующий путь. |
| «Bundle not found at /_rec/recorder.iife.js» | Забыл `cp sdk/dist/recorder.iife.js proxy/recorder-bundle/` после `pnpm build`. |
| Тесты проходят локально, валят в CI | В CI скорее всего нет Docker. Скипай сюиту там — variant-a должен быть local-only. |
| `EADDRINUSE` на 8080 | Кто-то другой держит порт. `lsof -i :8080`, потом kill, или поменяй порт в `proxy/docker-compose.yml`. |
