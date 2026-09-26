// Bellomy Workpapers — Cloudflare Worker
//
// Magic link endpoints (send files TO clients):
//   POST /upload         (auth) — upload a file, get a single-view link back
//   GET  /:token         — "click to view" landing page (idempotent, scanner-safe)
//   POST /:token         — consume: stream the file once, then self-delete
//
// Upload request endpoints (receive files FROM clients):
//   POST /create-upload-request  (auth) — register a token + label + expiry
//   GET  /upload-request/:token  — client-facing upload page (HTML)
//   POST /upload-request/:token  — client submits file(s)
//   GET  /check-uploads/:token   (auth) — list pending files for that token
//   GET  /download-upload/:token/:filename (auth) — fetch a pending file
//   DELETE /upload-request/:token (auth) — revoke an upload request
//
// Worksheet state (interactive information requests):
//   POST /worksheet/:token       — client autosaves answers (no auth, token-gated)
//   GET  /worksheet/:token       — client resumes on any device (no auth, token-gated)
//   GET  /inbox          (auth)  — every live request + its progress, for the digest
//   POST /publish-worksheet/:token (auth) — store the worksheet HTML for a token
//   GET  /w/:token               — serve it to the client (no auth, token-gated)
//
// Hosting the worksheet here rather than emailing it as an attachment is what
// makes it resumable in practice: the client gets one durable URL that works on
// a phone, survives a closed tab, and is same-origin with the save endpoint, so
// autosave and in-page file attachment need no CORS gymnastics.
//
// Bindings (wrangler.toml / dashboard):
//   MAGIC_LINKS_BUCKET  - R2 bucket
//   LINKS_KV            - KV namespace
//   UPLOAD_SECRET       - secret env var
//
// Retention
//   KV records self-expire via expirationTtl, but R2 objects have no TTL. Once a
//   KV record lapses its R2 objects become orphans that nothing lists and nothing
//   cleans, so client documents would sit in the bucket indefinitely. The daily
//   cron below sweeps them. Caps keep any single link inside the retention window.

const UR_DEFAULT_DAYS = 75     // upload requests: default life
const UR_MAX_DAYS     = 90     // upload requests: hard cap
const ML_DEFAULT_DAYS = 30     // magic links: default life (client sends)
const ML_MAX_DAYS     = 90     // magic links: hard cap
const SWEEP_GRACE_DAYS = 30    // extra grace after a record lapses before R2 is purged
const WS_MAX_BYTES = 262144    // worksheet autosave payload cap (256 KB). POST /worksheet/:token
                               // is unauthenticated by design — the token IS the credential —
                               // so the body must be bounded and JSON-validated before it is stored.

function clampDays(v, dflt, max) {
  const d = parseFloat(v)
  if (!isFinite(d) || d <= 0) return dflt
  return Math.min(d, max)
}

export default {
  // Daily sweep: purge R2 objects whose KV record has lapsed. Deliberately
  // conservative - an object is only removed when its record is GONE and the
  // object is older than the maximum link life plus a grace period, so nothing
  // inside a live window can ever be touched.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepOrphans(env))
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const parts = url.pathname.slice(1).split('/')  // e.g. ['upload-request', 'TOKEN']

    // ── Magic link: POST /upload ──────────────────────────────────────────────
    if (request.method === 'POST' && parts[0] === 'upload' && parts.length === 1) {
      return handleMagicUpload(request, env)
    }

    // ── Upload requests ───────────────────────────────────────────────────────
    if (parts[0] === 'create-upload-request' && request.method === 'POST') {
      return handleCreateUploadRequest(request, env)
    }
    if (parts[0] === 'upload-request' && parts[1]) {
      const token = parts[1]
      if (request.method === 'GET')  return handleUploadPage(token, env)
      if (request.method === 'POST') return handleClientUpload(token, request, env)
      if (request.method === 'DELETE') return handleRevokeUploadRequest(token, request, env)
    }
    if (parts[0] === 'check-uploads' && parts[1] && request.method === 'GET') {
      return handleCheckUploads(parts[1], request, env)
    }
    if (parts[0] === 'download-upload' && parts[1] && parts[2] && request.method === 'GET') {
      return handleDownloadUpload(parts[1], decodeURIComponent(parts[2]), request, env)
    }
    if (parts[0] === 'delete-upload' && parts[1] && parts[2] && request.method === 'DELETE') {
      return handleDeleteUpload(parts[1], decodeURIComponent(parts[2]), request, env)
    }

    // ── Worksheet state: server-side save/resume for interactive requests ─────
    // Both are unauthenticated and gated only by the 16-char token, exactly like
    // the upload page itself. Worksheets must therefore never ask for an SSN,
    // bank or account number — see the request-builder skill.
    if (parts[0] === 'worksheet' && parts[1] && parts.length === 2) {
      const token = parts[1]
      if (request.method === 'OPTIONS') return corsPreflight()
      if (request.method === 'GET')     return handleWorksheetLoad(token, env)
      if (request.method === 'POST')    return handleWorksheetSave(token, request, env)
    }

    // ── GET /inbox (auth) — everything outstanding, in one call ───────────────
    if (parts[0] === 'inbox' && parts.length === 1 && request.method === 'GET') {
      return handleInbox(request, env)
    }

    // ── The worksheet page itself ────────────────────────────────────────────
    if (parts[0] === 'publish-worksheet' && parts[1] && parts.length === 2 && request.method === 'POST') {
      return handlePublishWorksheet(parts[1], request, env)
    }
    if (parts[0] === 'w' && parts[1] && parts.length === 2 && request.method === 'GET') {
      return handleWorksheetPage(parts[1], env)
    }

    // ── Magic link: GET /:token — human-facing landing page (does NOT consume) ─
    // A bare GET is exactly what email security scanners (Defender Safe Links,
    // Proofpoint URL Defense, Mimecast, Barracuda, ...) issue to detonate links
    // in inbound mail. It must be idempotent and must NOT spend the one-time
    // view. It returns a "click to view" page whose button POSTs to consume.
    if (request.method === 'GET' && parts.length === 1 && parts[0]) {
      return handleLanding(parts[0], env, ctx)
    }

    // ── Magic link: POST /:token — consume + stream the file once ──────────────
    // Reached only when the human clicks "View Document". Scanners fetch/render
    // GET links but do not submit POST forms, so this is where the single view
    // is actually spent.
    if (request.method === 'POST' && parts.length === 1 && parts[0]) {
      return handleConsume(parts[0], env, ctx)
    }

    return new Response('Not found', { status: 404 })
  },
}

async function sweepOrphans(env) {
  const now = Date.now()
  const plans = [
    { prefix: 'ur/', kv: k => `ur:${k}`, maxAgeDays: UR_MAX_DAYS + SWEEP_GRACE_DAYS },
    { prefix: 'ml/', kv: k => `ml:${k}`, maxAgeDays: ML_MAX_DAYS + SWEEP_GRACE_DAYS },
    // Worksheet state is keyed ws/<token>.json (no directory segment), and its
    // lifetime is the upload request's, so it checks the same ur: record. Every
    // autosave rewrites the object, which refreshes `uploaded` — an actively
    // worked worksheet therefore never ages into the sweep.
    { prefix: 'ws/', kv: k => `ur:${k}`, maxAgeDays: UR_MAX_DAYS + SWEEP_GRACE_DAYS,
      tokenOf: rest => rest.replace(/\.(json|html)$/, '') },
  ]
  let purged = 0, scanned = 0
  for (const plan of plans) {
    let cursor
    do {
      const page = await env.MAGIC_LINKS_BUCKET.list({ prefix: plan.prefix, cursor, limit: 1000 })
      cursor = page.truncated ? page.cursor : undefined
      // Token is the path segment after the prefix: ur/<token>/<file> or ml/<token>
      const seen = new Map()
      for (const o of page.objects) {
        scanned++
        const rest = o.key.slice(plan.prefix.length)
        const token = plan.tokenOf ? plan.tokenOf(rest) : rest.split('/')[0]
        if (!token) continue
        const ageDays = (now - new Date(o.uploaded).getTime()) / 86400000
        if (ageDays <= plan.maxAgeDays) continue        // still inside the window
        if (!seen.has(token)) seen.set(token, await env.LINKS_KV.get(plan.kv(token)))
        if (seen.get(token)) continue                    // record still live - leave it
        await env.MAGIC_LINKS_BUCKET.delete(o.key)
        purged++
      }
    } while (cursor)
  }
  console.log(`sweepOrphans: scanned ${scanned}, purged ${purged}`)
  return { scanned, purged }
}

function shortId(len = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => chars[b % chars.length]).join('')
}

function auth(request, env) {
  return request.headers.get('Authorization') === `Bearer ${env.UPLOAD_SECRET}`
}

// ── Magic link: send file to client ──────────────────────────────────────────

async function handleMagicUpload(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'document')
  const expiresDays = clampDays(request.headers.get('X-Expires-Days'), ML_DEFAULT_DAYS, ML_MAX_DAYS)
  const token = shortId()
  const body = await request.arrayBuffer()
  await env.MAGIC_LINKS_BUCKET.put(`ml/${token}`, body)
  const expiresAt = Date.now() + expiresDays * 86400000
  await env.LINKS_KV.put(`ml:${token}`, JSON.stringify({ fileName, expiresAt, viewed: false }), {
    expirationTtl: Math.ceil(expiresDays * 86400) + 3600,
  })
  const origin = new URL(request.url).origin
  return new Response(JSON.stringify({ token, url: `${origin}/${token}` }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// GET /:token — idempotent "click to view" page. Never consumes the link, so
// an automated scanner GET leaves it intact for the human.
async function handleLanding(token, env, ctx) {
  const recordStr = await env.LINKS_KV.get(`ml:${token}`)
  if (!recordStr) return expiredPage()
  const record = JSON.parse(recordStr)
  if (record.viewed || Date.now() > record.expiresAt) {
    // Already spent or expired: cleanup is safe and idempotent.
    ctx.waitUntil(Promise.all([env.MAGIC_LINKS_BUCKET.delete(`ml/${token}`), env.LINKS_KV.delete(`ml:${token}`)]))
    return expiredPage()
  }
  // Valid and unspent — show the landing page WITHOUT touching the record.
  return new Response(landingPage(token, record.fileName), {
    headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store, private' },
  })
}

// POST /:token — spend the single view: stream the file once, then self-delete.
async function handleConsume(token, env, ctx) {
  const recordStr = await env.LINKS_KV.get(`ml:${token}`)
  if (!recordStr) return expiredPage()
  const record = JSON.parse(recordStr)
  if (record.viewed || Date.now() > record.expiresAt) {
    ctx.waitUntil(Promise.all([env.MAGIC_LINKS_BUCKET.delete(`ml/${token}`), env.LINKS_KV.delete(`ml:${token}`)]))
    return expiredPage()
  }
  const obj = await env.MAGIC_LINKS_BUCKET.get(`ml/${token}`)
  if (!obj) return expiredPage()
  record.viewed = true
  ctx.waitUntil(env.LINKS_KV.put(`ml:${token}`, JSON.stringify(record), { expirationTtl: 3600 }))
  ctx.waitUntil(env.MAGIC_LINKS_BUCKET.delete(`ml/${token}`))
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${record.fileName}"`,
      // One-time payload: keep any intermediary/scanner proxy from caching it.
      'Cache-Control': 'no-store, private',
    },
  })
}

// Branded interstitial served on GET. The "View Document" button POSTs back to
// the same URL, which is the step that actually consumes the link.
function landingPage(token, fileName) {
  const safeName = escapeHtml(fileName || 'a document')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Secure Document — Bellomy Accounting</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f3ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.10);max-width:480px;width:100%;overflow:hidden}
  .header{background:#2a2118;color:#fff;padding:24px 28px}
  .header h1{font-size:18px;font-weight:600;letter-spacing:-.2px}
  .header p{font-size:13px;color:#a89880;margin-top:4px}
  .body{padding:28px;text-align:center}
  .icon{width:48px;height:48px;stroke:#b8860b;margin:0 auto 16px;display:block}
  .body h2{font-size:17px;color:#2a2118;margin-bottom:8px}
  .fname{font-size:14px;color:#8a7a6a;margin-bottom:20px;word-break:break-word}
  .note{font-size:13px;color:#8a7a6a;background:#f8f6f2;border-radius:6px;padding:12px 16px;margin-bottom:22px;line-height:1.5}
  .btn{display:block;width:100%;padding:13px;background:#b8860b;color:#fff;font-size:15px;font-weight:600;border:none;border-radius:6px;cursor:pointer;transition:background .15s}
  .btn:hover{background:#9a6e08}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>Bellomy Accounting</h1>
    <p>Secure document</p>
  </div>
  <div class="body">
    <svg class="icon" fill="none" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
    <h2>Your accountant sent you a secure document</h2>
    <div class="fname">${safeName}</div>
    <div class="note">For your privacy, this document can be opened <strong>once</strong>. Click below when you're ready to view it.</div>
    <form method="POST" action="/${token}">
      <button class="btn" type="submit">View Document</button>
    </form>
  </div>
</div>
</body>
</html>`
}

// ── Upload requests: receive files from clients ───────────────────────────────

async function handleCreateUploadRequest(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const { label, instructions, expiresDays } = await request.json()
  const token = shortId(16)
  const days = clampDays(expiresDays, UR_DEFAULT_DAYS, UR_MAX_DAYS)
  const expiresAt = Date.now() + days * 86400000
  await env.LINKS_KV.put(`ur:${token}`, JSON.stringify({ label, instructions, expiresAt, createdAt: Date.now(), files: [] }), {
    expirationTtl: Math.ceil(days * 86400) + 3600,
  })
  const origin = new URL(request.url).origin
  return new Response(JSON.stringify({ token, url: `${origin}/upload-request/${token}`, expiresAt, expiresDays: days }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleUploadPage(token, env) {
  const recordStr = await env.LINKS_KV.get(`ur:${token}`)
  if (!recordStr) return expiredUploadPage()
  const record = JSON.parse(recordStr)
  if (Date.now() > record.expiresAt) return expiredUploadPage()

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Secure Document Upload — Bellomy Accounting</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f3ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.10);max-width:520px;width:100%;overflow:hidden}
  .header{background:#2a2118;color:#fff;padding:24px 28px}
  .header h1{font-size:18px;font-weight:600;letter-spacing:-.2px}
  .header p{font-size:13px;color:#a89880;margin-top:4px}
  .body{padding:28px}
  .label{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#8a7a6a;margin-bottom:8px}
  .instructions{font-size:14px;color:#3a3028;background:#f8f6f2;border-radius:6px;padding:12px 16px;margin-bottom:24px;line-height:1.5}
  .drop{border:2px dashed #c8bfb0;border-radius:8px;padding:40px 24px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;background:#faf9f7}
  .drop.over{border-color:#b8860b;background:#fef9ea}
  .drop svg{width:40px;height:40px;stroke:#c8bfb0;margin-bottom:12px}
  .drop p{font-size:14px;color:#8a7a6a}
  .drop em{color:#b8860b;font-style:normal;font-weight:600}
  #fileInput{display:none}
  .file-list{margin-top:16px;display:flex;flex-direction:column;gap:6px}
  .file-item{display:flex;align-items:center;gap:10px;background:#f5f3ef;border-radius:6px;padding:8px 12px;font-size:13px}
  .file-item .name{flex:1;color:#3a3028;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-item .size{color:#8a7a6a;white-space:nowrap}
  .file-item .remove{color:#b5443a;cursor:pointer;font-size:16px;line-height:1;flex-shrink:0}
  .btn{display:block;width:100%;margin-top:20px;padding:12px;background:#b8860b;color:#fff;font-size:14px;font-weight:600;border:none;border-radius:6px;cursor:pointer;transition:background .15s}
  .btn:hover:not(:disabled){background:#9a6e08}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .progress{height:4px;background:#e8e0d4;border-radius:2px;margin-top:14px;overflow:hidden;display:none}
  .progress-bar{height:100%;background:#b8860b;width:0;transition:width .2s}
  .success{text-align:center;padding:32px 28px}
  .success svg{width:56px;height:56px;stroke:#3d7a2e;margin-bottom:16px}
  .success h2{font-size:18px;color:#2a2118;margin-bottom:8px}
  .success p{font-size:14px;color:#8a7a6a}
  .error-msg{color:#b5443a;font-size:13px;margin-top:10px;display:none}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>Bellomy Accounting</h1>
    <p>Secure document upload</p>
  </div>
  <div id="main" class="body">
    <div class="label">Requested documents</div>
    <div class="instructions">${escapeHtml(record.instructions || record.label || 'Please upload your documents below.')}</div>
    <div class="drop" id="drop" onclick="document.getElementById('fileInput').click()">
      <svg fill="none" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/></svg>
      <p>Drop files here or <em>browse</em></p>
    </div>
    <input type="file" id="fileInput" multiple/>
    <div class="file-list" id="fileList"></div>
    <button class="btn" id="submitBtn" disabled>Upload Documents</button>
    <div class="progress" id="progress"><div class="progress-bar" id="progressBar"></div></div>
    <div class="error-msg" id="errorMsg"></div>
  </div>
  <div id="successView" style="display:none" class="success">
    <svg fill="none" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    <h2>Documents uploaded successfully</h2>
    <p>Your accountant has been notified and will review your documents shortly.</p>
  </div>
</div>
<script>
const token = ${JSON.stringify(token)}
const files = []
const drop = document.getElementById('drop')
const fileInput = document.getElementById('fileInput')
const fileList = document.getElementById('fileList')
const submitBtn = document.getElementById('submitBtn')
const errorMsg = document.getElementById('errorMsg')

drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files) })
fileInput.addEventListener('change', () => addFiles(fileInput.files))

function addFiles(newFiles) {
  for (const f of newFiles) {
    if (!files.find(x => x.name === f.name)) files.push(f)
  }
  renderList()
}
function removeFile(name) {
  const idx = files.findIndex(f => f.name === name)
  if (idx >= 0) files.splice(idx, 1)
  renderList()
}
function formatSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB'
  return (n/1048576).toFixed(1) + ' MB'
}
function renderList() {
  fileList.innerHTML = files.map(f =>
    \`<div class="file-item"><span class="name">\${f.name}</span><span class="size">\${formatSize(f.size)}</span><span class="remove" onclick="removeFile('\${f.name.replace(/'/g,"\\\\'")}')">&times;</span></div>\`
  ).join('')
  submitBtn.disabled = files.length === 0
}
submitBtn.addEventListener('click', async () => {
  if (!files.length) return
  submitBtn.disabled = true
  errorMsg.style.display = 'none'
  const progress = document.getElementById('progress')
  const bar = document.getElementById('progressBar')
  progress.style.display = 'block'
  try {
    for (let i = 0; i < files.length; i++) {
      bar.style.width = Math.round((i / files.length) * 100) + '%'
      const fd = new FormData()
      fd.append('file', files[i], files[i].name)
      const r = await fetch('/upload-request/' + token, { method: 'POST', body: fd })
      if (!r.ok) throw new Error(await r.text())
    }
    bar.style.width = '100%'
    setTimeout(() => {
      document.getElementById('main').style.display = 'none'
      document.getElementById('successView').style.display = ''
    }, 400)
  } catch(e) {
    errorMsg.textContent = 'Upload failed: ' + e.message
    errorMsg.style.display = 'block'
    submitBtn.disabled = false
  }
})
</script>
</body>
</html>`

  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } })
}

async function handleClientUpload(token, request, env) {
  const recordStr = await env.LINKS_KV.get(`ur:${token}`)
  if (!recordStr) return new Response('Link not found or expired', { status: 410 })
  const record = JSON.parse(recordStr)
  if (Date.now() > record.expiresAt) return new Response('Link expired', { status: 410 })

  const form = await request.formData()
  const file = form.get('file')
  if (!file) return new Response('No file', { status: 400 })

  const safeFileName = file.name.replace(/[^a-zA-Z0-9._\-\s]/g, '_')
  const key = `ur/${token}/${safeFileName}`
  await env.MAGIC_LINKS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  })

  // No KV write here on purpose: the inbox list is derived from R2 in
  // handleCheckUploads, so we never maintain a separate files[] array that could
  // desync or be clobbered by concurrent uploads/saves (lost-update race).
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleCheckUploads(token, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const recordStr = await env.LINKS_KV.get(`ur:${token}`)
  if (!recordStr) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { headers: { 'Content-Type': 'application/json' } })
  const record = JSON.parse(recordStr)
  // Source of truth for what's available is R2, not a KV array. Listing storage
  // directly means already-saved files (deleted from R2) never linger as
  // phantoms, and any file present in R2 is always shown — no desync, no race.
  const prefix = `ur/${token}/`
  const listed = await env.MAGIC_LINKS_BUCKET.list({ prefix })
  const files = listed.objects.map(o => o.key.slice(prefix.length))
  return new Response(JSON.stringify({ ok: true, files, label: record.label, expiresAt: record.expiresAt }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// Normalize a filename for lenient matching: collapse whitespace runs, NFC
// unicode, strip case. Guards against whitespace/unicode drift between the
// stored R2 key and the name the app looks up.
function normName(s) {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

async function handleDownloadUpload(token, filename, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const prefix = `ur/${token}/`
  let obj = await env.MAGIC_LINKS_BUCKET.get(prefix + filename)
  if (!obj) {
    // Exact key missed — list what's actually under this token and match
    // leniently. If nothing matches, report what IS there so the failure is
    // diagnosable instead of a bare 404 (e.g. the object was never stored or
    // was already saved+deleted).
    const listed = await env.MAGIC_LINKS_BUCKET.list({ prefix })
    const want = normName(filename)
    const hit = listed.objects.find(o => normName(o.key.slice(prefix.length)) === want)
    if (hit) obj = await env.MAGIC_LINKS_BUCKET.get(hit.key)
    if (!obj) {
      const available = listed.objects.map(o => o.key.slice(prefix.length))
      return new Response(
        JSON.stringify({ error: 'File not found in storage', requested: filename, available }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

async function handleDeleteUpload(token, filename, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const prefix = `ur/${token}/`
  // Delete the exact key AND any leniently-matching object, so a file served
  // via the lenient match in handleDownloadUpload is actually cleaned up rather
  // than lingering in R2 (and staying listed).
  const want = normName(filename)
  const listed = await env.MAGIC_LINKS_BUCKET.list({ prefix })
  const toDelete = new Set([prefix + filename])
  for (const o of listed.objects) {
    if (normName(o.key.slice(prefix.length)) === want) toDelete.add(o.key)
  }
  await Promise.all([...toDelete].map(k => env.MAGIC_LINKS_BUCKET.delete(k)))
  // No KV update: the inbox list is derived from R2, so removing the object(s)
  // is all that's needed — and it avoids the read-modify-write race entirely.
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleRevokeUploadRequest(token, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  // Delete the pending files too. Dropping only the KV record would strand any
  // already-uploaded objects in R2 with nothing left pointing at them.
  const prefix = `ur/${token}/`
  const listed = await env.MAGIC_LINKS_BUCKET.list({ prefix })
  await Promise.all(listed.objects.map(o => env.MAGIC_LINKS_BUCKET.delete(o.key)))
  // The worksheet answers live outside that prefix — drop them in the same
  // breath, otherwise revoking would strand them exactly as it used to strand
  // uploaded files.
  await Promise.all([
    env.MAGIC_LINKS_BUCKET.delete(`ws/${token}.json`),
    env.MAGIC_LINKS_BUCKET.delete(`ws/${token}.html`),
  ])
  await env.LINKS_KV.delete(`ur:${token}`)
  return new Response(JSON.stringify({ ok: true, purged: listed.objects.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Worksheet state ──────────────────────────────────────────────────────────
// An interactive information request is a static HTML file the client keeps.
// Its answers live here, under the same token as the upload request, so the
// client can resume on any device and Billy can read partial progress without
// waiting for a submit.

const WS_CORS = {
  // The worksheet is usually opened as a local file (origin `null`), so the
  // browser needs an explicit allow to fetch/post here. The token is the only
  // credential and is never a cookie, so a wildcard origin grants nothing extra.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: WS_CORS })
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Client financial answers: never let a proxy or the browser cache them.
      'Cache-Control': 'no-store, private',
      ...WS_CORS,
    },
  })
}

// The worksheet lives under the upload request's token and dies with it.
async function liveUploadRecord(token, env) {
  const recordStr = await env.LINKS_KV.get(`ur:${token}`)
  if (!recordStr) return null
  const record = JSON.parse(recordStr)
  if (Date.now() > record.expiresAt) return null
  return record
}

async function handleWorksheetLoad(token, env) {
  const record = await liveUploadRecord(token, env)
  if (!record) return jsonResponse({ ok: false, error: 'expired' }, 410)
  const empty = { ok: true, answers: {}, answered: 0, total: 0, submitted: false, savedAt: null, label: record.label || '' }
  const obj = await env.MAGIC_LINKS_BUCKET.get(`ws/${token}.json`)
  if (!obj) return jsonResponse(empty)   // nothing saved yet is a normal first visit
  let state
  try { state = JSON.parse(await obj.text()) } catch { state = null }
  if (!state || typeof state !== 'object') return jsonResponse(empty)
  return jsonResponse({ ok: true, ...state, label: record.label || state.label || '' })
}

async function handleWorksheetSave(token, request, env) {
  const record = await liveUploadRecord(token, env)
  if (!record) return jsonResponse({ ok: false, error: 'expired' }, 410)

  const raw = await request.text()
  if (raw.length > WS_MAX_BYTES) return jsonResponse({ ok: false, error: 'payload too large' }, 413)
  let body
  try { body = JSON.parse(raw) } catch { return jsonResponse({ ok: false, error: 'invalid json' }, 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: 'invalid body' }, 400)
  }

  const answers = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) ? body.answers : {}
  const total = Number.isFinite(body.total) ? Math.max(0, Math.trunc(body.total)) : 0
  const answered = Object.keys(answers).length
  const submitted = body.submitted === true
  const savedAt = Date.now()
  const state = { answers, total, answered, submitted, savedAt, label: record.label || '' }

  await env.MAGIC_LINKS_BUCKET.put(`ws/${token}.json`, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
    // Mirrored into customMetadata so GET /inbox can report progress from a
    // head() instead of fetching and parsing every worksheet body.
    customMetadata: {
      answered: String(answered),
      total: String(total),
      submitted: submitted ? '1' : '0',
      savedAt: String(savedAt),
    },
  })

  // On submit, drop a readable transcript into the FILE inbox as well. That is
  // what raises the existing badge in the Workpapers app — no app change needed.
  if (submitted) {
    const text = typeof body.text === 'string' && body.text ? body.text : renderTranscript(state)
    const stamp = new Date(savedAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '')
    const base = (record.label || 'worksheet').replace(/[^a-zA-Z0-9._\-\s]/g, '_')
    await env.MAGIC_LINKS_BUCKET.put(`ur/${token}/${base} - submitted ${stamp}.txt`, text, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    })
  }

  return jsonResponse({ ok: true, savedAt, answered, total, submitted })
}

// Fallback transcript when the page did not send its own formatted text.
function renderTranscript(state) {
  const lines = [
    state.label || 'Worksheet',
    'Submitted: ' + new Date(state.savedAt).toISOString(),
    `Answered ${state.answered} of ${state.total} items`,
    '',
  ]
  for (const [q, v] of Object.entries(state.answers)) lines.push(`${q}: ${v}`)
  return lines.join('\n')
}

// ── The worksheet page ───────────────────────────────────────────────────────
// Billy publishes the generated HTML against a token; the client opens /w/:token.
// Same origin as /worksheet/:token and /upload-request/:token, so the page can
// autosave and attach files with a plain fetch.

const WS_PAGE_MAX_BYTES = 2097152   // 2 MB — a self-contained worksheet is ~40 KB

async function handlePublishWorksheet(token, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const record = await liveUploadRecord(token, env)
  if (!record) return jsonResponse({ ok: false, error: 'no live upload request for that token' }, 410)
  const html = await request.text()
  if (!html) return jsonResponse({ ok: false, error: 'empty body' }, 400)
  if (html.length > WS_PAGE_MAX_BYTES) return jsonResponse({ ok: false, error: 'page too large' }, 413)
  await env.MAGIC_LINKS_BUCKET.put(`ws/${token}.html`, html, {
    httpMetadata: { contentType: 'text/html;charset=utf-8' },
  })
  const origin = new URL(request.url).origin
  return jsonResponse({ ok: true, url: `${origin}/w/${token}`, bytes: html.length })
}

async function handleWorksheetPage(token, env) {
  const record = await liveUploadRecord(token, env)
  if (!record) return expiredUploadPage()
  const obj = await env.MAGIC_LINKS_BUCKET.get(`ws/${token}.html`)
  if (!obj) return expiredUploadPage()
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      // The page is a shell; the answers arrive from /worksheet/:token. Keeping
      // it uncached means a corrected worksheet republished mid-season is picked
      // up on the client's next visit rather than served stale from their cache.
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

// ── GET /inbox — one call for the morning digest ─────────────────────────────
// Walks every live ur: record and reports what has arrived against it: files
// uploaded, and worksheet progress read straight from R2 customMetadata.
async function handleInbox(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const now = Date.now()
  const requests = []
  let cursor
  do {
    const page = await env.LINKS_KV.list({ prefix: 'ur:', cursor })
    cursor = page.list_complete ? undefined : page.cursor
    for (const k of page.keys) {
      const token = k.name.slice(3)
      const recStr = await env.LINKS_KV.get(k.name)
      if (!recStr) continue                       // lapsed between list and get
      const rec = JSON.parse(recStr)
      const prefix = `ur/${token}/`
      const listed = await env.MAGIC_LINKS_BUCKET.list({ prefix })
      const head = await env.MAGIC_LINKS_BUCKET.head(`ws/${token}.json`)
      const page = await env.MAGIC_LINKS_BUCKET.head(`ws/${token}.html`)
      const m = head?.customMetadata || {}
      requests.push({
        token,
        label: rec.label || '',
        createdAt: rec.createdAt || null,
        expiresAt: rec.expiresAt,
        expired: now > rec.expiresAt,
        daysLeft: Math.max(0, Math.round((rec.expiresAt - now) / 86400000)),
        files: listed.objects.map(o => ({ name: o.key.slice(prefix.length), size: o.size, uploaded: o.uploaded })),
        hasPage: !!page,
        worksheet: head ? {
          answered: parseInt(m.answered, 10) || 0,
          total: parseInt(m.total, 10) || 0,
          submitted: m.submitted === '1',
          savedAt: parseInt(m.savedAt, 10) || null,
        } : null,
      })
    }
  } while (cursor)
  requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return jsonResponse({ ok: true, count: requests.length, requests })
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function expiredPage() {
  return new Response(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>This link has expired or has already been viewed.</h2>
      <p>Please contact your accountant for a new link.</p>
    </body></html>`,
    { status: 410, headers: { 'Content-Type': 'text/html' } }
  )
}

function expiredUploadPage() {
  return new Response(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>This upload link has expired.</h2>
      <p>Please contact your accountant for a new link.</p>
    </body></html>`,
    { status: 410, headers: { 'Content-Type': 'text/html' } }
  )
}
