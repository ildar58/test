# Как собрать IIFE-бандл для proxy-инжекта

nginx-прокси раздаёт `/_rec/recorder.iife.js` как статический файл.
Этот бандл собирается из исходников SDK через esbuild.

## Шаги сборки

```bash
# Из корня репо
cd sdk
pnpm install
pnpm build
# Output: sdk/dist/recorder.iife.js

# Скопировать в proxy-bundle dir
cp sdk/dist/recorder.iife.js proxy/recorder-bundle/recorder.iife.js
```

## Что делает бандл

IIFE экспортирует один глобал `PamRecorder` с двумя методами: `init`
и `stop`. nginx инжектит маленький inline-скрипт, который зовёт
`PamRecorder.init({ endpoint: '/s/' })` безусловно в каждом HTML-ответе.

Рекордер стартует в IDLE. Активируется только когда бэкенд выставит
non-HttpOnly cookie-маркер `session_present=1` на логине, и
деактивируется, когда эта cookie исчезает на logout. UUID сессии
управляется внутри SDK через `sessionStorage` — со страницы хоста
никакая идентичность не передаётся.

См. [`docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md`](../../docs/superpowers/specs/2026-05-28-auth-gated-recording-design.md)
для полного контракта.
