// Bellomy Workpapers — Cloudflare Worker
//
// Magic link endpoints (send files TO clients):
//   POST /upload         (auth) — upload a file, get a single-view link back
//   GET  /:token         — stream the file once, self-delete
//
// Upload request endpoints (receive files FROM clients):
//   POST /create-upload-request  (auth) — register a token + label + expiry
//   GET  /upload-request/:token  — client-facing upload page (HTML)
//   POST /upload-request/:token  — client submits file(s)
//   GET  /check-uploads/:token   (auth) — list pending files for that token
//   GET  /download-upload/:token/:filename (auth) — fetch a pending file
//   DELETE /upload-request/:token (auth) — revoke an upload request
//
// Bindings (wrangler.toml / dashboard):
//   MAGIC_LINKS_BUCKET  - R2 bucket
//   LINKS_KV            - KV namespace
//   UPLOAD_SECRET       - secret env var

export default {
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
      return handleDownloadUpload(parts[1], parts[2], request, env)
    }
    if (parts[0] === 'delete-upload' && parts[1] && parts[2] && request.method === 'DELETE') {
      return handleDeleteUpload(parts[1], parts[2], request, env)
    }

    // ── Magic link: GET /:token ───────────────────────────────────────────────
    if (request.method === 'GET' && parts.length === 1 && parts[0]) {
      return handleView(parts[0], env, ctx)
    }

    return new Response('Not found', { status: 404 })
  },
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
  const expiresDays = parseFloat(request.headers.get('X-Expires-Days') || '7')
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

async function handleView(token, env, ctx) {
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
    },
  })
}

// ── Upload requests: receive files from clients ───────────────────────────────

async function handleCreateUploadRequest(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const { label, instructions, expiresDays } = await request.json()
  const token = shortId(16)
  const expiresAt = Date.now() + (expiresDays || 30) * 86400000
  await env.LINKS_KV.put(`ur:${token}`, JSON.stringify({ label, instructions, expiresAt, files: [] }), {
    expirationTtl: Math.ceil((expiresDays || 30) * 86400) + 3600,
  })
  const origin = new URL(request.url).origin
  return new Response(JSON.stringify({ token, url: `${origin}/upload-request/${token}` }), {
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

  if (!record.files.includes(safeFileName)) record.files.push(safeFileName)
  const ttl = Math.ceil((record.expiresAt - Date.now()) / 1000) + 3600
  await env.LINKS_KV.put(`ur:${token}`, JSON.stringify(record), { expirationTtl: Math.max(ttl, 3600) })

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleCheckUploads(token, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const recordStr = await env.LINKS_KV.get(`ur:${token}`)
  if (!recordStr) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { headers: { 'Content-Type': 'application/json' } })
  const record = JSON.parse(recordStr)
  return new Response(JSON.stringify({ ok: true, files: record.files, label: record.label, expiresAt: record.expiresAt }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleDownloadUpload(token, filename, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const key = `ur/${token}/${filename}`
  const obj = await env.MAGIC_LINKS_BUCKET.get(key)
  if (!obj) return new Response('Not found', { status: 404 })
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

async function handleDeleteUpload(token, filename, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  const key = `ur/${token}/${filename}`
  await env.MAGIC_LINKS_BUCKET.delete(key)
  const recordStr = await env.LINKS_KV.get(`ur:${token}`)
  if (recordStr) {
    const record = JSON.parse(recordStr)
    record.files = record.files.filter(f => f !== filename)
    const ttl = Math.ceil((record.expiresAt - Date.now()) / 1000) + 3600
    await env.LINKS_KV.put(`ur:${token}`, JSON.stringify(record), { expirationTtl: Math.max(ttl, 3600) })
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleRevokeUploadRequest(token, request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 })
  await env.LINKS_KV.delete(`ur:${token}`)
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
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
