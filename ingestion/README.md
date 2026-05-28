# Ingestion Service (stub of the Go contract)

Express server that accepts session batches from the nginx-injected recorder.
This is a stub of the production Go service — sufficient to drive the local
demo and E2E tests, but not a production-grade implementation.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Stub: sets `session=<user>; HttpOnly` and `session_present=1` cookies. |
| POST | `/auth/logout` | Stub: clears both cookies (`Max-Age=0`). |
| POST | `/s/` | Ingest event batch. Requires `session` cookie — returns 401 otherwise. `user_id` is derived from the cookie value and stored alongside the batch. |
| GET | `/sessions` | List all sessions. |
| GET | `/sessions/:id` | Get full event array for a session. |

## Run

```bash
cd ingestion
pnpm install
pnpm dev        # tsx watch
# or
pnpm build && pnpm start
```

Default port: `3001`. Override via `PORT` env var.

## Storage

Batches are stored in `./data/<session_id>.jsonl` (one JSON line per batch).
Session metadata in `./data/<session_id>.meta.json` includes the server-derived
`user_id`. No database needed for the stub. Replace `storage.ts` with a real
DB adapter when porting to Go.
