# Ingestion-сервис (стаб Go-контракта)

Express-сервер, принимающий батчи событий от nginx-инжектированного
рекордера. Это стаб настоящего Go-сервиса — достаточно, чтобы гонять
локальное демо и E2E, но не production-grade реализация.

## Эндпоинты

| Method | Path | Описание |
|--------|------|----------|
| POST | `/auth/login` | Стаб: ставит cookies `session=<token>; HttpOnly` (token — random hex) и `session_present=1`. Проверяет пароль через bcryptjs против захардкоженных юзеров. |
| POST | `/auth/logout` | Стаб: чистит обе cookie (`Max-Age=0`) и убивает запись в in-memory session-store. |
| POST | `/s/` | Приём батча событий. Требует cookie `session` — иначе 401. `user_id` выводится из значения cookie и сохраняется рядом с батчем. |
| GET | `/sessions` | Список всех сессий. |
| GET | `/sessions/:id` | Полный массив событий по сессии. |

## Запуск

```bash
cd ingestion
pnpm install
pnpm dev        # tsx watch
# или
pnpm build && pnpm start
```

Дефолтный порт: `3001`. Переопределяется через env `PORT`.

## Хранилище

Батчи append'ятся в `./data/<session_id>.jsonl` (одна JSON-строка на
батч). Метаданные сессии — в `./data/<session_id>.meta.json`, включая
выведенный сервером `user_id`. БД не нужна для стаба. Замени
`storage.ts` на адаптер настоящей БД при портировании в Go.
