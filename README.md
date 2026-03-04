# Monolith Render Service

Render-ready service for generating single-file HTML archives using [Monolith](https://github.com/Y2Z/monolith), with optional upload to S3.

## Why this exists

- Cloudflare Workers cannot run Monolith directly as a local binary process.
- Render can run Dockerized services that invoke Monolith.
- This keeps ops light while supporting single-file HTML output.

## Supabase S3 compatibility

If your bucket is Supabase Storage via S3 compatibility, set:

- `S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3`
- `S3_FORCE_PATH_STYLE=true`
- `S3_REGION=us-east-1` (or the region shown by Supabase)
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from Supabase S3 credentials

## Endpoints

- `GET /health`
- `GET /archive?url=https://example.com`
- `POST /archive`

### Query/body fields

- `url` (required): target page URL
- `timeoutSec` (optional): capture timeout, default `60`, max `180`
- `isolate` (optional): Monolith `-I`, default `true`
- `ignoreErrors` (optional): Monolith `-e`, default `true`
- `excludeJavascript` (optional): Monolith `-j`, default `false`
- `store` (optional): upload to S3 and return JSON metadata, default `false`
- `key` (optional): explicit S3 object key
- `userAgent` (optional): custom User-Agent

## Local run

```bash
npm install
npm run dev
```

Then test:

```bash
curl -L "http://127.0.0.1:10000/archive?url=https://example.com" -o archive.html -D -
```

## Deploy to Render

1. Push this folder to GitHub.
2. In Render, create a **Web Service** from that repo.
3. Select **Docker** runtime (Render will use `Dockerfile`).
4. Set environment variables:
   - `S3_BUCKET`
   - `S3_REGION`
   - optional for S3-compatible providers: `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - optional: `S3_PREFIX`, `MONOLITH_TIMEOUT_SEC`
5. Deploy.

Blueprint option: `render.yaml` is included in this folder.

## Deploy without pushing source to GitHub

Render supports image-backed services. You can deploy from a Docker image instead of repository sync.

1. Create a Render web service from an existing Docker image.
2. Set the same env vars in Render.
3. Use the local deploy script to build/push and trigger deploy:

```bash
IMAGE_REPO=docker.io/<you>/plinky-monolith-archive \
RENDER_DEPLOY_HOOK_URL="https://api.render.com/deploy/srv-...?...key=..." \
npm run deploy:image
```

Alternative trigger with Render CLI:

```bash
IMAGE_REPO=docker.io/<you>/plinky-monolith-archive \
RENDER_SERVICE_ID=srv-xxxxxxxx \
npm run deploy:image
```

## S3 upload example

```bash
curl -X POST "https://<your-render-service>/archive" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://www.mlbtraderumors.com/2026/03/mlb-mailbag-braves-profar-white-sox-mariners.html",
    "store": true
  }'
```

Response includes `bucket`, `key`, `sizeBytes`, and duration.

## Important Monolith limitation

Monolith has no JavaScript engine. JS-heavy pages may need a browser pre-render step before Monolith.
