# Variant A — nginx proxy injection

nginx sits in front of the corp app. It injects `recorder.iife.js` into every
HTML response via `sub_filter`. The app itself is unchanged.

## Prerequisites

- Docker + Docker Compose
- Built IIFE bundle (see `recorder-bundle/build.md`)

## Quick start

```bash
# 1. Build IIFE bundle
cd sdk && pnpm install && pnpm build:iife
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js

# 2. Start the stack
cd proxy
docker compose up --build

# Corp app (with recorder injected): http://localhost:8000
# Replayer admin:                    http://localhost:8080
```

## Key nginx decisions

| Config line | Why |
|---|---|
| `proxy_set_header Accept-Encoding ""` | Disables upstream gzip so `sub_filter` can see plain HTML |
| `sub_filter </head> ...` | Injects the recorder before `</head>` — works for all pages |
| `sub_filter_once on` | Inject only once (prevents double-inject on pages with `</head>` in JS) |
| `location /_rec/` | Recorder bundle served as static, not proxied — faster |
| `location /s/` | Batch POST forwarded to ingestion |

## CSP note

If the corp app has a strict CSP, you need a per-request nonce.
Options:
1. nginx-plus: `set_secure_random_alphanum $nonce 32;` then inject into both CSP header and the script tag.
2. lua-nginx-module: `local nonce = require("resty.random").bytes(16, true)`
3. Upstream app: generate nonce server-side, pass via response header, nginx reads it with `$upstream_http_x_csp_nonce`.
