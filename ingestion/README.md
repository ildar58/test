# Ingestion Service

Express server that accepts session batches from both Variant A and Variant B.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/s/` | Ingest event batch |
| GET | `/sessions` | List all sessions |
| GET | `/sessions/:id` | Get full event array for session |

## Run

```bash
cd ingestion
pnpm install
pnpm dev        # ts-node hot reload
# or
pnpm build && pnpm start
```

Default port: `3001`. Override via `PORT` env var.

## Storage

Batches are stored in `./data/<session_id>.jsonl` (one JSON line per batch).
Session metadata in `./data/<session_id>.meta.json`.

No database needed for MVP. Replace `storage.ts` with a real DB adapter later.
