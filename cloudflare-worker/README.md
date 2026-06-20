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
   This prints your Worker URL, e.g. `https://bellomy-magic-links.<your-subdomain>.workers.dev`.

6. In the Bellomy Workpapers app, open Settings → Magic Links and enter:
   - **Worker URL** — the URL from step 5
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
