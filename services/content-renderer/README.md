# Content Renderer

Small internal Playwright service for the parser recovery pipeline. This is not
a general browsing service and it should not be exposed publicly.

## Purpose

The backend parser stays static-first. Only rows that were already marked as
weak and escalated into rendered recovery call this service. The service
renders a URL, blocks low-value assets, and returns the final HTML so the normal
parser registry can run again on a fully rendered document.

The backend caller is in
[`supabase/functions/_shared/content/rendered_fetch.ts`](../../supabase/functions/_shared/content/rendered_fetch.ts).

## Contract

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `POST /render`

Headers:

- `content-type: application/json`
- `x-content-renderer-secret: <CONTENT_RENDERER_SECRET>`

Body:

```json
{
  "url": "https://example.com/article",
  "waitUntil": "networkidle",
  "timeoutMs": 30000
}
```

Rules:

- `url` must be an absolute public `http` or `https` URL.
- local, private, and credentialed URLs are rejected.
- non-default ports are rejected.
- `waitUntil` must be `domcontentloaded`, `load`, or `networkidle`.

Success response:

```json
{
  "resolvedUrl": "https://example.com/article",
  "status": 200,
  "html": "<!doctype html>..."
}
```

## Environment

Service environment:

- `CONTENT_RENDERER_BIND_ADDR`
  Default: `0.0.0.0`
- `CONTENT_RENDERER_PORT`
  Default: `8788`. On Railway, the service will also honor the platform `PORT`
  variable automatically.
- `CONTENT_RENDERER_SECRET`
  Required shared secret for backend requests.
- `CONTENT_RENDERER_MAX_REQUEST_BYTES`
  Default: `16384`
- `CONTENT_RENDERER_MAX_HTML_BYTES`
  Default: `3145728`
- `CONTENT_RENDERER_DEFAULT_TIMEOUT_MS`
  Default: `30000`
- `CONTENT_RENDERER_MAX_TIMEOUT_MS`
  Default: `45000`
- `CONTENT_RENDERER_MAX_CONCURRENCY`
  Default: `2`
- `CONTENT_RENDERER_ALLOWED_HOSTS`
  Optional comma-separated allowlist. When unset, any public host is allowed.

Backend environment:

- `CONTENT_RENDERER_URL`
- `CONTENT_RENDERER_SECRET`

See:

- [`.env.example`](./.env.example)
- [`../../.env.example`](../../.env.example)

## Local Run

Install dependencies:

```bash
cd services/content-renderer
npm install
```

Run the service:

```bash
cp .env.example .env
CONTENT_RENDERER_SECRET=change-me npm start
```

Run tests:

```bash
npm test
```

## Docker

Build:

```bash
docker build -t motif-content-renderer services/content-renderer
```

Run:

```bash
docker run --rm -p 8788:8788 \
  -e CONTENT_RENDERER_SECRET=change-me \
  motif-content-renderer
```

The image ships with a container healthcheck that probes `GET /health`.

## Deployment

### Single-host Docker Compose

The simplest safe deployment is to keep the renderer bound to loopback on the
same server as the backend.

Setup:

```bash
cd services/content-renderer
cp .env.production.example .env.production
```

Then edit `.env.production` and set a real `CONTENT_RENDERER_SECRET`.

Bring it up:

```bash
docker compose up -d --build
```

Check health:

```bash
docker compose ps
docker compose logs --tail=100
curl -sS http://127.0.0.1:8788/health
```

The example [compose.yaml](./compose.yaml) binds `127.0.0.1:8788:8788` on
purpose. That keeps the service off the public internet. If your backend runs
on another host, do not simply expose this publicly. Put it behind a private
network or internal load balancer and keep the shared secret enabled.

### Backend Wiring

On the backend host, set:

```env
CONTENT_RENDERER_URL=http://127.0.0.1:8788/render
CONTENT_RENDERER_SECRET=<same secret as renderer>
```

If the renderer runs on a different private host, replace `127.0.0.1` with the
internal DNS name or private address.

### Railway

Deploy this directory as a separate Railway service using the existing
[Dockerfile](./Dockerfile).

Set at minimum:

- `CONTENT_RENDERER_SECRET`
- `CONTENT_RENDERER_MAX_CONCURRENCY=2`

You do not need to set `CONTENT_RENDERER_PORT` on Railway unless you want to
override the platform port. The service will use Railway's injected `PORT`
variable automatically.

Then copy the public Railway service URL into the Supabase secret:

```env
CONTENT_RENDERER_URL=https://<your-railway-renderer-domain>/render
CONTENT_RENDERER_SECRET=<same secret as Railway service>
```

Because Supabase needs to call it, this URL must be reachable from outside
Railway. Keep the shared secret enabled.

### Bring-up Checklist

1. Apply the parser recovery migrations so the rendered queue exists.
2. Deploy the renderer service and confirm `GET /health` returns `{"ok":true}`.
3. Set `CONTENT_RENDERER_URL` and `CONTENT_RENDERER_SECRET` for the backend.
4. Deploy the edge function [process-content-render-recovery-batch](../../supabase/functions/process-content-render-recovery-batch).
5. Trigger one known recovery candidate and confirm the stored row advances from
   `parser_recovery_stage = 'rendered'` to `succeeded` or `dismissed`.

### Smoke Test

You can call the renderer directly once it is up:

```bash
curl -sS http://127.0.0.1:8788/render \
  -H 'content-type: application/json' \
  -H 'x-content-renderer-secret: change-me' \
  -d '{
    "url": "https://example.com/",
    "waitUntil": "domcontentloaded",
    "timeoutMs": 10000
  }' | jq '.status, .resolvedUrl'
```

### Capacity Notes

- Start with `CONTENT_RENDERER_MAX_CONCURRENCY=1` or `2`.
- Chromium is the expensive part. Give this service real memory headroom.
- Keep timeouts tight. If a host consistently needs more than `45s`, it should
  probably not be in the rendered-recovery path by default.
- If only a handful of hosts truly need rendering, consider setting
  `CONTENT_RENDERER_ALLOWED_HOSTS` so the service cannot be abused as a generic
  browser.

## Operational Notes

- Keep this service private to backend infrastructure.
- Do not add stealth or ban-evasion logic here.
- Keep the Docker base image and the `playwright` package pinned to the same
  exact version. Do not use a caret range here, or the service can boot while
  Chromium is missing at runtime.
- The request policy intentionally blocks images, fonts, media, and common
  analytics hosts to reduce cost and shrink rendered noise.
- If a host needs special handling, prefer adjusting parser recovery routing
  first, not loosening the renderer into a general crawler.
