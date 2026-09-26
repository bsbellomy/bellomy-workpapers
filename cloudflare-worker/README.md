# Bellomy Magic Links — Cloudflare Worker

This Worker is the gatekeeper for single-view magic links. It binds directly
to your R2 bucket and a KV namespace — no R2 API keys are needed by the
Worker or by the desktop app. (The R2 access key/secret you generated earlier
are not used by this design; you can keep them or revoke them.)

## One-time setup

1. Install Wrangler (Cloudflare's CLI) if you don't have it:
   ```
   npm install -g wrangler
   wrangler login
   ```

2. Create the R2 bucket (skip if you already made one named differently —
   just update `bucket_name` in `wrangler.toml`):
   ```
   wrangler r2 bucket create bellomy-magic-links
   ```

3. Create the KV namespace:
   ```
   wrangler kv namespace create LINKS_KV
   ```
   This prints an `id`. Copy it into `wrangler.toml` in place of
   `PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

4. Set the upload secret (make up a long random string — this is the
   password the app uses to authenticate uploads). Save it; you'll paste
   the same value into the app's Settings:
   ```
   wrangler secret put UPLOAD_SECRET
   ```

5. Deploy:
   ```
   cd cloudflare-worker
   wrangler deploy
   ```
   This prints your Worker URL. If `bellomycpa.com` is already on this
   Cloudflare account, `wrangler.toml` attaches a custom domain
   (`share.bellomycpa.com`) automatically instead of the default
   `*.workers.dev` URL — much friendlier for clients to click.

6. In the Bellomy Workpapers app, open Settings → Magic Links and enter:
   - **Worker URL** — `https://share.bellomycpa.com` (this is also the
     app's built-in default, so you only need to set this if you deploy
     to a different domain)
   - **Upload secret** — the value you set in step 4

## How it works

- App uploads the file straight to the Worker (`POST /upload`), which stores
  it in R2 and creates a KV record with an expiration timestamp.
- The emailed link points at the Worker (`GET /:token`).
- First visit: Worker streams the file back, then deletes it from R2
  immediately (single-view).
- Any visit after expiry, or a second visit: Worker deletes the file (if
  still present) and shows "this link has expired or already been viewed."
- KV records auto-expire via `expirationTtl`, so nothing lingers even if a
  link is never clicked.

No cron job or app-side cleanup is needed — cleanup happens at the moment a
link is accessed (or attempted).

## Optional safety net

If you want a hard backstop in case a file is uploaded and the link is never
clicked, you can add an R2 object lifecycle rule in the Cloudflare dashboard
(R2 → your bucket → Settings → Object lifecycle rules) to auto-delete objects
older than, say, 30 days. Not required, just extra insurance.

## Retention

KV records self-expire (`expirationTtl`), **but R2 objects have no TTL**. Before Sept 2026 that
meant every uploaded client document stayed in the bucket permanently: once the KV record lapsed
its R2 objects became orphans that nothing listed and nothing cleaned. Two further leaks fed it —
`handleRevokeUploadRequest` deleted only the KV record, and a magic link that nobody ever clicked
never reached its cleanup path.

| Setting | Value |
|---|---|
| Upload request — default life | **75 days** |
| Upload request — hard cap | **90 days** |
| Magic link — default life | **30 days** (was 7) |
| Magic link — hard cap | **90 days** |
| Grace before R2 is purged | **30 days** past the cap |

`expiresDays` / `X-Expires-Days` are clamped by `clampDays()`, so a caller cannot create something
that outlives the policy. Missing, zero, negative and non-numeric all fall back to the default.

### The sweep

`scheduled()` runs `sweepOrphans()` daily at 07:00 UTC (`[triggers]` in `wrangler.toml`). It walks
the `ur/` and `ml/` prefixes and deletes an object only when **both** are true:

1. its KV record is **gone**, and
2. the object is older than the hard cap **plus** the grace period (120 days).

So nothing inside a live window can ever be touched, and a live record protects its files however
old they are. It pages through `list()` with a cursor and caches the KV lookup per token.

Run the guard tests before deploying — this code deletes client documents:

```bash
node cloudflare-worker/sweep.test.mjs
```

### Deploying

```bash
cd cloudflare-worker
npx wrangler login          # or set CLOUDFLARE_API_TOKEN
npx wrangler deploy         # picks up [triggers] and registers the cron
```

Optional belt-and-braces — an R2 lifecycle rule, independent of the worker:

```bash
npx wrangler r2 bucket lifecycle add bellomy-magic-links \
  --name purge-old --prefix "" --expire-days 180
```

To sweep once by hand instead of waiting for the cron:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```
