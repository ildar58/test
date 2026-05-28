# Replayer UI

Однофайловая HTML-страница, которая грузит `rrweb-player` с CDN и
воспроизводит сессии, полученные из ingestion-сервиса.

## Доступ

После поднятия стека:

- Через ingestion-сервис напрямую: `http://localhost:3001/replay`
  (при `pnpm dev:ingestion`)
- Через nginx admin-порт: `http://localhost:8081`
- Через основной nginx-порт: `http://localhost:8080/replay/`

## Зависимости (CDN — установка не нужна)

- `rrweb-player` latest с jsDelivr

## Кастомизация

Замени CDN-ссылки на локальные сборки для air-gapped окружений:

```html
<link rel="stylesheet" href="/assets/rrweb-player.css" />
<script src="/assets/rrweb-player.js"></script>
```
