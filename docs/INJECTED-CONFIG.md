# Дизайн: кастомизация рекордера через `data-*` при инъекции nginx

Статус: согласовано (2026-06-03). Позволяет оператору настраивать рекордер
(endpoint, имена cookie, тайминги и т.д.) **прямо в nginx.conf**, без пересборки
бандла. Расширяет инъекцию из [`proxy/nginx.conf`](../proxy/nginx.conf) и точку
входа SDK [`sdk/src/index.ts`](../sdk/src/index.ts).

## 1. Цель

Сейчас nginx инжектит фиксированный сниппет с жёстко зашитым `init({endpoint:"/s/"})`.
Нужно: оператор задаёт конфиг в nginx.conf, бандл не пересобирается, любое поле
`RecorderConfig` переопределяемо, privacy-дефолты сохраняются.

### Вне области (отложено)

- env-driven значения (`envsubst`-шаблон) — выбрана **статика** в nginx.conf.
- Объектное поле `maskInputOptions` через атрибут — остаётся из `DEFAULT_CONFIG`.
- Конфиг-эндпоинт (`/_rec/config.json`).

## 2. Механизм (вариант A: data-атрибуты + авто-init)

Один тег вместо двух. nginx инжектит:

```html
<script src="/_rec/recorder.iife.js" data-endpoint="/s/"></script>
```

Бандл при загрузке читает **свой** тег через `document.currentScript`, парсит его
`data-*` в `Partial<RecorderConfig>` и сам вызывает `init()` (мёрж поверх
`DEFAULT_CONFIG`). Прежний второй inline-скрипт `init()` удаляется.

- **Парсер** — отдельный чистый модуль [`sdk/src/script-config.ts`](../sdk/src/script-config.ts):
  `parseDatasetConfig(dataset: DOMStringMap): Partial<RecorderConfig>`. Без DOM-зависимостей,
  тестируется передачей обычного объекта.
- **Авто-init** в `index.ts`: если `document.currentScript` — это `<script>`, вызвать
  `init(parseDatasetConfig(currentScript.dataset))`. Если `currentScript === null`
  (ESM-импорт, юнит-тесты) — не делать ничего; остаётся публичный `init()`.
  `init` идемпотентен (`if (instance) return`) — двойного старта нет.
- Публичные `init()` / `stop()` сохраняются (программное использование, тесты).

## 3. Контракт атрибутов

`data-*` именуются kebab-case; DOM отдаёт их в `dataset` как camelCase. Парсер
ведёт **allowlist** (таблица ниже); неизвестные `data-*` игнорируются.

| `data-` атрибут | `dataset`-ключ | Поле `RecorderConfig` | Тип |
|---|---|---|---|
| `data-endpoint` | `endpoint` | `endpoint` | string |
| `data-marker-cookie` | `markerCookie` | `markerCookieName` | string |
| `data-session-id-cookie` | `sessionIdCookie` | `sessionIdCookieName` | string |
| `data-flush-interval-ms` | `flushIntervalMs` | `flushIntervalMs` | number |
| `data-marker-poll-ms` | `markerPollMs` | `markerPollMs` | number |
| `data-max-buffer-size` | `maxBufferSize` | `maxBufferSize` | number |
| `data-checkout-every-ms` | `checkoutEveryMs` | `checkoutEveryNms` | number |
| `data-unauthorized-threshold` | `unauthorizedThreshold` | `unauthorizedThreshold` | number |
| `data-unauthorized-cooldown-ms` | `unauthorizedCooldownMs` | `unauthorizedCooldownMs` | number |
| `data-block-class` | `blockClass` | `blockClass` | string |
| `data-ignore-class` | `ignoreClass` | `ignoreClass` | string |
| `data-mask-text-class` | `maskTextClass` | `maskTextClass` | string |
| `data-mask-all-inputs` | `maskAllInputs` | `maskAllInputs` | boolean |
| `data-inline-stylesheet` | `inlineStylesheet` | `inlineStylesheet` | boolean |
| `data-collect-fonts` | `collectFonts` | `collectFonts` | boolean |
| `data-record-cross-origin-iframes` | `recordCrossOriginIframes` | `recordCrossOriginIframes` | boolean |

### Правила коэрции

- **string** — значение как есть (пустую строку пропускаем).
- **number** — `Number(v)`; если `!Number.isFinite(n)` → поле **опускается** (дефолт).
- **boolean** — `"true"`→`true`, `"false"`→`false`; иное → поле **опускается**.
- Атрибут отсутствует → поле не попадает в результат → берётся `DEFAULT_CONFIG`.

Результат — только заданные и валидные поля. Невалидное значение никогда не
доходит до `init` (не ломает `RecorderConfig`).

## 4. Изменения по компонентам

### SDK

- **Новый** [`sdk/src/script-config.ts`](../sdk/src/script-config.ts): таблица-маппинг
  + `parseDatasetConfig(dataset)`. Экспортирует функцию и (для тестов) таблицу.
- **[`sdk/src/index.ts`](../sdk/src/index.ts):** в конце модуля — авто-init:
  ```ts
  const self = typeof document !== 'undefined' ? document.currentScript : null;
  if (self instanceof HTMLScriptElement) init(parseDatasetConfig(self.dataset));
  ```
  `init`/`stop`/`InitOptions` — без изменений.

### Proxy ([`proxy/nginx.conf`](../proxy/nginx.conf))

`sub_filter` в публичном `server` (location `/`) — заменить двойной сниппет на
одиночный тег с `data-endpoint` как видимым примером + комментарий со списком
поддерживаемых `data-*`:

```nginx
# Recorder config via data-* on the injected tag (read by the bundle on load).
# Supported: data-endpoint, data-marker-cookie, data-session-id-cookie,
# data-flush-interval-ms, data-marker-poll-ms, data-max-buffer-size,
# data-checkout-every-ms, data-unauthorized-threshold, data-unauthorized-cooldown-ms,
# data-block-class, data-ignore-class, data-mask-text-class, data-mask-all-inputs,
# data-inline-stylesheet, data-collect-fonts, data-record-cross-origin-iframes.
# Omitted attributes fall back to the SDK DEFAULT_CONFIG.
sub_filter_once on;
sub_filter_types text/html;
sub_filter '</head>' '<script src="/_rec/recorder.iife.js" data-endpoint="/s/"></script></head>';
```

Бандл пересобрать и скопировать в `proxy/recorder-bundle/` (как раньше).

## 5. Обработка ошибок

- `currentScript === null` (ESM/тесты) → авто-init не запускается, без ошибок.
- Кривое число/булево в атрибуте → поле опускается, `init` получает валидный subset.
- Неизвестный `data-*` → игнорируется (allowlist).
- `endpoint` не задан → `DEFAULT_CONFIG.endpoint` (`/s/`).

## 6. Тестирование

- **Юнит (`script-config.test.ts`):** каждый атрибут маппится в нужное поле с
  нужным типом; неизвестные игнорируются; кривые number/boolean отбрасываются;
  пустой dataset → `{}`; пустая строка пропускается.
- **Юнит (index/авто-init):** при наличии псевдо-`currentScript` с `data-*`
  вызывается `init` со склеенным конфигом (через тонкую тестируемую обвязку);
  при `currentScript === null` — `init` не вызывается.
- **E2E (variant-a):** проверку инъекции обновить на одиночный тег
  `<script src="/_rec/recorder.iife.js" data-endpoint="/s/">`; запись по-прежнему
  стартует и батчи доходят (регресс существующих сценариев).

## 7. Совместимость

- Глобал `PamRecorder.init/stop` остаётся — программный путь не ломается.
- Поведение по умолчанию идентично текущему: `data-endpoint="/s/"` ⇒ `endpoint:"/s/"`,
  остальное из `DEFAULT_CONFIG` (включая privacy-дефолты `maskAllInputs:false` и т.д.).
