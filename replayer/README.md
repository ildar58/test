# Replayer UI

Single HTML page that loads `rrweb-player` from CDN and plays back sessions
fetched from the ingestion service.

## Access

After starting the stack:

- Via ingestion service: `http://localhost:3001/replay`
- Via nginx admin port: `http://localhost:8080`

## Dependencies (CDN — no install needed)

- `rrweb-player` latest from jsDelivr

## Customization

Replace CDN links with local builds for air-gapped environments:

```html
<link rel="stylesheet" href="/assets/rrweb-player.css" />
<script src="/assets/rrweb-player.js"></script>
```
