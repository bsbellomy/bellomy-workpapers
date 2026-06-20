// Bellomy Workpapers — magic link gatekeeper Worker
//
// Endpoints:
//   POST /upload   (auth: Authorization: Bearer <UPLOAD_SECRET>)
//                  headers: X-File-Name, X-Expires-Days
//                  body: raw file bytes
//                  -> { token, url }
//   GET  /:token   -> streams the file once, then deletes it (single-view).
//                     Also deletes + invalidates if the link has expired.
//
// Bindings required (set in wrangler.toml or the dashboard):
//   MAGIC_LINKS_BUCKET  - R2 bucket binding
//   LINKS_KV            - Workers KV namespace binding
//   UPLOAD_SECRET       - secret env var (wrangler secret put UPLOAD_SECRET)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const token = url.pathname.slice(1)

    if (request.method === 'POST' && token === 'upload') {
      return handleUpload(request, env)
    }
    if (request.method === 'GET' && token) {
      return handleView(token, env, ctx)
    }
    return new Response('Not found', { status: 404 })
  },
}

async function handleUpload(request, env) {
  const auth = request.headers.get('Authorization')
  if (auth !== `Bearer ${env.UPLOAD_SECRET}`) return new Response('Unauthorized', { status: 401 })

  const fileName = decodeURIComponent(request.headers.get('X-File-Name') || 'document')
  const expiresDays = parseFloat(request.headers.get('X-Expires-Days') || '7')
  const token = crypto.randomUUID().replace(/-/g, '')
  const body = await request.arrayBuffer()

  await env.MAGIC_LINKS_BUCKET.put(token, body)
  const expiresAt = Date.now() + expiresDays * 86400000
  await env.LINKS_KV.put(
    token,
    JSON.stringify({ fileName, expiresAt, viewed: false }),
    { expirationTtl: Math.ceil(expiresDays * 86400) + 3600 }
  )

  const linkUrl = new URL(request.url)
  return new Response(JSON.stringify({ token, url: `${linkUrl.origin}/${token}` }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleView(token, env, ctx) {
  const recordStr = await env.LINKS_KV.get(token)
  if (!recordStr) return expiredPage()

  const record = JSON.parse(recordStr)
  if (record.viewed || Date.now() > record.expiresAt) {
    ctx.waitUntil(Promise.all([env.MAGIC_LINKS_BUCKET.delete(token), env.LINKS_KV.delete(token)]))
    return expiredPage()
  }

  const obj = await env.MAGIC_LINKS_BUCKET.get(token)
  if (!obj) return expiredPage()

  record.viewed = true
  ctx.waitUntil(env.LINKS_KV.put(token, JSON.stringify(record), { expirationTtl: 3600 }))
  ctx.waitUntil(env.MAGIC_LINKS_BUCKET.delete(token))

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${record.fileName}"`,
    },
  })
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
