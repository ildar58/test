#!/usr/bin/env bash
# Idempotent setup for the Angular fixture app used by variant-b e2e tests.
# Run from repo root or from e2e/ directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NG_APP_DIR="$SCRIPT_DIR/ng-app"

echo "[pam-e2e] setup-fixture.sh — checking $NG_APP_DIR"

# ── Idempotency check ──────────────────────────────────────────────────────────
if [ -f "$NG_APP_DIR/package.json" ]; then
  echo "[pam-e2e] ng-app already exists, skipping scaffold"
  echo "[pam-e2e] fixture ready"
  exit 0
fi

# ── Scaffold Angular app ───────────────────────────────────────────────────────
cd "$SCRIPT_DIR"
echo "[pam-e2e] scaffolding Angular 18 app..."
npx -y @angular/cli@18 new ng-app \
  --routing \
  --style=scss \
  --ssr=false \
  --skip-git \
  --skip-tests \
  --defaults

# ── Install SDK as file dependency ────────────────────────────────────────────
cd "$NG_APP_DIR"
echo "[pam-e2e] installing @pam/web-session-recorder from SDK..."
npm install "file:../../../sdk"

# ── Patch src/main.ts to init recorder before bootstrap ──────────────────────
echo "[pam-e2e] patching src/main.ts..."
cat > src/main.ts << 'MAIN_TS'
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { init } from '@pam/web-session-recorder';

// __PAM_ENDPOINT__ will be replaced by ng-build.ts helper before ng build
const endpoint: string = '__PAM_ENDPOINT__';

init({ endpoint });

bootstrapApplication(AppComponent, appConfig).catch((err: unknown) =>
  console.error(err)
);

console.log('[pam-e2e] fixture ready');
MAIN_TS

# ── Generate page components ──────────────────────────────────────────────────
echo "[pam-e2e] generating page components..."
npx ng generate component pages/form --standalone --flat=false
npx ng generate component pages/list --standalone --flat=false
npx ng generate component pages/canvas-demo --standalone --flat=false

# ── Patch app.routes.ts ───────────────────────────────────────────────────────
echo "[pam-e2e] patching app.routes.ts..."
cat > src/app/app.routes.ts << 'ROUTES_TS'
import { Routes } from '@angular/router';
import { FormComponent } from './pages/form/form.component';
import { ListComponent } from './pages/list/list.component';
import { CanvasDemoComponent } from './pages/canvas-demo/canvas-demo.component';

export const routes: Routes = [
  { path: '', redirectTo: 'form', pathMatch: 'full' },
  { path: 'form', component: FormComponent },
  { path: 'list', component: ListComponent },
  { path: 'canvas-demo', component: CanvasDemoComponent },
];
ROUTES_TS

# ── Patch app.component.html ──────────────────────────────────────────────────
echo "[pam-e2e] patching app.component.html..."
cat > src/app/app.component.html << 'APP_HTML'
<nav>
  <a routerLink="/form" routerLinkActive="active">Form</a>
  <a routerLink="/list" routerLinkActive="active">List</a>
  <a routerLink="/canvas-demo" routerLinkActive="active">Canvas</a>
</nav>
<router-outlet />
APP_HTML

# ── Add RouterModule imports to AppComponent ──────────────────────────────────
echo "[pam-e2e] patching app.component.ts imports..."
# Replace imports array to include RouterOutlet and RouterLink
sed -i '' \
  's/imports: \[/imports: [RouterOutlet, RouterLink, RouterLinkActive, /' \
  src/app/app.component.ts 2>/dev/null || \
sed -i \
  's/imports: \[/imports: [RouterOutlet, RouterLink, RouterLinkActive, /' \
  src/app/app.component.ts

# Add import statements if not present
if ! grep -q "RouterOutlet" src/app/app.component.ts; then
  sed -i '' \
    "1s/^/import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular\/router';\n/" \
    src/app/app.component.ts 2>/dev/null || \
  sed -i \
    "1s/^/import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular\/router';\n/" \
    src/app/app.component.ts
fi

# ── Add a simple form input to FormComponent ─────────────────────────────────
cat > src/app/pages/form/form.component.html << 'FORM_HTML'
<h2>Form Page</h2>
<form>
  <label for="name">Name:</label>
  <input id="name" type="text" placeholder="Enter your name" />
  <label for="email">Email:</label>
  <input id="email" type="email" placeholder="Enter your email" />
  <button type="submit">Submit</button>
</form>
FORM_HTML

echo "[pam-e2e] fixture ready"
