# @pam/video

CLI экспорта записанной сессии в `.webm` видеофайл.

Используется через корневой скрипт:

```bash
pnpm video <session_id>
# → ingestion/data/<session_id>.webm
```

## Как работает

1. Читает `ingestion/data/<session_id>.jsonl`.
2. Декодирует gzip+base64 батчи в плоский массив событий через
   [`src/decode.ts`](src/decode.ts) (покрыто 9 unit-тестами).
3. Собирает HTML, инлайня `rrweb-player` UMD + CSS из `node_modules` и
   массив событий.
4. Запускает Playwright (`chromium.launch({ executablePath, headless: true })`).
   `executablePath` берётся из env `CHROME_EXECUTABLE` или авто-находится
   под `~/chrome/mac_arm-*` (от `npx @puppeteer/browsers install chrome@stable`).
5. Создаёт context с `recordVideo`, рендерит HTML через `setContent`,
   ждёт callback `onReplayFinish` от rrweb-player'а (с timeout-fallback'ом
   `lastEvent.timestamp - firstEvent.timestamp + 10s`).
6. Закрывает context — Playwright финализирует `.webm`.
7. Перемещает результат в `ingestion/data/<sid>.webm`.

## Почему не `rrvideo`

Изначально хотел использовать `rrvideo` (есть на npm), но он хардкодит
`chromium.launch({ headless: config.headless })` без `executablePath`.
В современной модели Playwright headless требует отдельный бинарник
`chromium-headless-shell`, который для macOS arm64 фактически не
поставляется. Без `executablePath` запустить нечем. Пришлось
переписать ~80 строк логики rrvideo с прямым launch'ем Chrome for
Testing — это и есть содержимое `src/export.ts`.

## macOS arm64: auto-heal Playwright ffmpeg

Playwright поставляет `~/Library/Caches/ms-playwright/ffmpeg-*/ffmpeg-mac`
**без подписи**. На arm64 Gatekeeper убивает его на старте (exit 137),
и `recordVideo` падает с криптическим `spawn Unknown system error -88`.

CLI авто-чинит при первом запуске:

1. Пробует запустить `ffmpeg-mac -version`.
2. Если падает (exit != 0) — находит системный ffmpeg через
   `command -v ffmpeg` и копирует поверх Playwright'овского.
3. Один раз на машину; идемпотентно.

Тебе нужно один раз поставить системный ffmpeg:

```bash
brew install ffmpeg
```

Без него auto-heal ничего сделать не сможет и выдаст понятную ошибку.

## Тесты

```bash
pnpm --filter @pam/video test       # vitest: 9 тестов на decoder
pnpm --filter @pam/video typecheck  # tsc --noEmit
```

E2E-теста на сам экспорт нет (рендер видео тяжёлый, ~5с на сессию —
не место в unit-сюите). Smoke-проверка: поднять Docker-стек, сделать
запись, прогнать `pnpm video <sid>`, посмотреть размер `.webm`.

## Известные ограничения

- macOS-only auto-heal ffmpeg. На Linux/Windows стек Playwright'а
  работает из коробки; на Linux нужен только установленный ffmpeg в
  Docker-образе или `apt install ffmpeg`.
- Один-shot пайплайн. Длинные сессии (часы) грузятся в память
  целиком. Для коротких демо-сессий ОК.
- Формат всегда `.webm` (Playwright recordVideo дефолт). Для MP4 —
  пост-шаг через ffmpeg:
  ```bash
  ffmpeg -i <sid>.webm -c:v libx264 -preset fast <sid>.mp4
  ```
- Если синтетические события не доигрывают до `finish` event'а
  (например, без последнего IncrementalSnapshot), CLI завершает по
  fallback-timeout'у и сохраняет то, что отрендерилось до этого.
