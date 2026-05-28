# @pam/web-session-recorder (внутренний)

Исходник IIFE-бандла рекордера, который инжектится nginx'ом.

Этот пакет **не публикуется в npm** — он существует только для того,
чтобы собирать `dist/recorder.iife.js`, который `proxy/nginx.conf`
раздаёт по `/_rec/recorder.iife.js`.

## Сборка

```bash
pnpm --filter @pam/web-session-recorder build
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

## Runtime-контракт

`init({ endpoint })` регистрирует рекордер. Он сидит в IDLE, пока
бэкенд не выставит cookie-маркер `session_present=1` на логине; на
logout, когда маркер исчезает, рекордер стопает и чистит session id.

Идентичность пользователя **не** входит в wire-формат — сервер
выводит её из HttpOnly cookie `session`, которую браузер шлёт
автоматически с каждым батчем.

См. [`docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md`](../docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md)
для полной архитектуры.

## Дефолты конфига

См. `src/config.ts`. Ключевые privacy-дефолты:
- `maskAllInputs: true`
- `blockClass: 'rec-no-capture'`
- `maskTextClass: 'rec-mask'`
- `collectFonts: false`
