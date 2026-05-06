# @pam/web-session-recorder SDK (Variant B)

npm SDK for modern apps. Import, init, done.

## Install

```bash
pnpm add @pam/web-session-recorder
```

## Usage

### Vanilla JS / React / Vue

```ts
import { init, stop, identify, addCustomEvent } from '@pam/web-session-recorder';

init({
  endpoint: '/s/',
  sessionId: crypto.randomUUID(),
  distinctId: 'user@example.com',
});

// optional
identify('user@example.com', { role: 'admin' });
addCustomEvent('checkout_started', { cart_size: 3 });

// on SPA unmount
stop();
```

### Angular

```ts
// app.component.ts
import { init, stop } from '@pam/web-session-recorder';

@Component({ ... })
export class AppComponent implements OnInit, OnDestroy {
  ngOnInit() {
    init({ endpoint: '/s/', sessionId: crypto.randomUUID(), distinctId: this.authService.userId });
  }
  ngOnDestroy() { stop(); }
}
```

## Build IIFE bundle for proxy injection

```bash
pnpm build:iife
# produces dist/recorder.iife.js — copy to proxy/recorder-bundle/
```

## Config defaults

See `src/config.ts`. Key privacy defaults:
- `maskAllInputs: true`
- `blockClass: 'rec-no-capture'`
- `maskTextClass: 'rec-mask'`
- `collectFonts: false`
