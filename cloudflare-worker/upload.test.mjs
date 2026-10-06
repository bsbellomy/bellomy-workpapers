// Offline test for client upload naming and the upload-request/worksheet split.
//
//   node cloudflare-worker/upload.test.mjs
//
// Both of these exist because of a live failure on 2026-10-05:
//
//   1. R2 put() overwrites silently. A client attached nine phone photos, every
//      one named "image.jpg", and eight were destroyed. Nothing errored, and the
//      worksheet listed all nine names back, so the loss was invisible on both
//      sides until the figures were reconciled against the documents.
//   2. /upload-request/<token> and /w/<token> share a token and both answer 200.
//      The wrong one was sent to a client, who saw a working page with no
//      questions on it.
//
// Fakes R2 with the same surface the worker uses.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'worker.js'), 'utf8')

function grab(name) {
  let start = src.indexOf(`async function ${name}(`)
  if (start < 0) start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not find ${name} in worker.js`)
  // Walk braces from the first { after the signature.
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const triesMatch = src.match(/^const UPLOAD_NAME_TRIES = \d+/m)
if (!triesMatch) throw new Error('UPLOAD_NAME_TRIES missing from worker.js')

const mod = await import('data:text/javascript,' + encodeURIComponent(
  triesMatch[0] + '\n' +
  grab('freeUploadKey') + '\n' +
  grab('handleUploadPageOrWorksheet') + '\n' +
  // handleUploadPageOrWorksheet falls through to the dropbox page; we only care
  // which branch it takes, so stub the HTML builder.
  "async function handleUploadPage(token, env) { return new Response('DROPBOX', { status: 200 }) }\n" +
  'export { freeUploadKey, handleUploadPageOrWorksheet, UPLOAD_NAME_TRIES }'
))
const { freeUploadKey, handleUploadPageOrWorksheet, UPLOAD_NAME_TRIES } = mod

function makeEnv(objects = {}) {
  const r2 = new Map(Object.entries(objects).map(([k, v]) => [k, { body: v }]))
  return {
    _r2: r2,
    MAGIC_LINKS_BUCKET: {
      async head(k) { return r2.has(k) ? { size: 1 } : null },
      async put(k, body) { r2.set(k, { body }) },
    },
  }
}

let passed = 0, failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')) }
}

console.log('\nUpload naming never overwrites\n' + '='.repeat(64))

{
  const env = makeEnv()
  const k = await freeUploadKey('T', 'image.jpg', env)
  check('first upload keeps its name', k === 'ur/T/image.jpg', k)
}

{
  const env = makeEnv({ 'ur/T/image.jpg': 'first' })
  const k = await freeUploadKey('T', 'image.jpg', env)
  check('second gets " (2)"', k === 'ur/T/image (2).jpg', k)
}

{
  // The real Minton case: nine photos, all called image.jpg.
  const env = makeEnv()
  const keys = []
  for (let i = 0; i < 9; i++) {
    const k = await freeUploadKey('T', 'image.jpg', env)
    await env.MAGIC_LINKS_BUCKET.put(k, 'photo' + i)
    keys.push(k)
  }
  check('nine identical names -> nine distinct keys',
    new Set(keys).size === 9, keys.join(', '))
  check('nine uploads -> nine objects in R2',
    env._r2.size === 9, String(env._r2.size))
  check('no earlier photo was clobbered',
    [...env._r2.values()].map(o => o.body).sort().join() ===
    ['photo0','photo1','photo2','photo3','photo4','photo5','photo6','photo7','photo8'].join())
}

{
  const env = makeEnv({ 'ur/T/scan': 'first' })
  const k = await freeUploadKey('T', 'scan', env)
  check('extensionless name still disambiguates', k === 'ur/T/scan (2)', k)
}

{
  const env = makeEnv({ 'ur/T/.gitignore': 'first' })
  const k = await freeUploadKey('T', '.gitignore', env)
  check('leading-dot name is not split into stem/ext',
    k === 'ur/T/.gitignore (2)', k)
}

{
  const env = makeEnv({ 'ur/T/a.b.c.pdf': 'first' })
  const k = await freeUploadKey('T', 'a.b.c.pdf', env)
  check('only the last dot is the extension', k === 'ur/T/a.b.c (2).pdf', k)
}

{
  // Exhaust the numbered range and confirm it still never overwrites.
  const seed = { 'ur/T/x.pdf': 'f' }
  for (let n = 2; n <= UPLOAD_NAME_TRIES; n++) seed[`ur/T/x (${n}).pdf`] = 'f'
  const env = makeEnv(seed)
  const k = await freeUploadKey('T', 'x.pdf', env)
  check('beyond the numbered range it falls back, not overwrites',
    !(k in seed) && k.startsWith('ur/T/x (') && k.endsWith(').pdf'), k)
}

{
  const env = makeEnv({ 'ur/OTHER/image.jpg': 'theirs' })
  const k = await freeUploadKey('T', 'image.jpg', env)
  check('another token\'s file does not force a rename', k === 'ur/T/image.jpg', k)
}

console.log('\nupload-request must not shadow a worksheet\n' + '='.repeat(64))

const url = s => new URL(s)

{
  const env = makeEnv({ 'ws/T.html': '<html>' })
  const r = await handleUploadPageOrWorksheet('T', url('https://share.x/upload-request/T'), env)
  check('worksheet exists -> 302', r.status === 302, String(r.status))
  check('302 points at /w/<token>',
    r.headers.get('Location') === 'https://share.x/w/T', r.headers.get('Location'))
}

{
  const env = makeEnv()
  const r = await handleUploadPageOrWorksheet('T', url('https://share.x/upload-request/T'), env)
  check('plain upload request still serves the dropbox',
    r.status === 200 && (await r.text()) === 'DROPBOX', String(r.status))
}

{
  const env = makeEnv({ 'ws/T.html': '<html>' })
  const r = await handleUploadPageOrWorksheet('T', url('https://share.x/upload-request/T?upload=1'), env)
  check('?upload=1 escape hatch reaches the dropbox',
    r.status === 200 && (await r.text()) === 'DROPBOX', String(r.status))
}

{
  const env = makeEnv({ 'ws/T.html': '<html>' })
  const r = await handleUploadPageOrWorksheet('T', url('https://share.x/upload-request/T?upload=0'), env)
  check('only upload=1 bypasses, not any upload param', r.status === 302, String(r.status))
}

{
  // The worksheet's own attach buttons POST here; the redirect is GET-only and
  // handled at the router, but prove the origin is carried, not hardcoded.
  const env = makeEnv({ 'ws/T.html': '<html>' })
  const r = await handleUploadPageOrWorksheet('T', url('http://localhost:8787/upload-request/T'), env)
  check('redirect uses the request origin',
    r.headers.get('Location') === 'http://localhost:8787/w/T', r.headers.get('Location'))
}

// ── folderPath persistence + the entity-decoded transcript ───────────────────
// A second harness: handleCreateUploadRequest / handleSetUploadFolder / handleInbox
// need auth, jsonResponse, shortId, clampDays and KV, so stub the first three and
// grab the rest from worker.js.
const mod2 = await import('data:text/javascript,' + encodeURIComponent(
  'const UR_DEFAULT_DAYS = 75, UR_MAX_DAYS = 90\n' +
  'let __id = 0\n' +
  "function shortId() { return 'tok' + (++__id) }\n" +
  'function clampDays(v, d) { return d }\n' +
  "function auth(request, env) { return request.headers.get('Authorization') === 'Bearer S' }\n" +
  "function jsonResponse(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } }) }\n" +
  grab('handleCreateUploadRequest') + '\n' +
  grab('handleSetUploadFolder') + '\n' +
  grab('handleInbox') + '\n' +
  grab('decodeEntities') + '\n' +
  grab('safeFromCodePoint') + '\n' +
  'export { handleCreateUploadRequest, handleSetUploadFolder, handleInbox, decodeEntities }'
))
const { handleCreateUploadRequest, handleSetUploadFolder, handleInbox, decodeEntities } = mod2

function kvEnv(kv = {}, r2 = {}) {
  const K = new Map(Object.entries(kv).map(([k, v]) => [k, JSON.stringify(v)]))
  const R = new Map(Object.entries(r2))
  return {
    _kv: K,
    LINKS_KV: {
      async get(k) { return K.has(k) ? K.get(k) : null },
      async put(k, v) { K.set(k, v) },
      async delete(k) { K.delete(k) },
      async list({ prefix }) { return { keys: [...K.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true } },
    },
    MAGIC_LINKS_BUCKET: {
      async head(k) { return R.has(k) ? { customMetadata: R.get(k).customMetadata || {} } : null },
      async list({ prefix }) { return { objects: [...R.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, size: 1, uploaded: new Date().toISOString() })) } },
    },
  }
}
const authed = (method, body) => new Request('https://x/y', { method, headers: { Authorization: 'Bearer S' }, body: body === undefined ? undefined : JSON.stringify(body) })
const bodyOf = async r => JSON.parse(await r.text())

console.log('\nfolderPath persistence\n' + '='.repeat(64))
{
  const env = kvEnv()
  const r = await bodyOf(await handleCreateUploadRequest(new Request('https://x/create-upload-request', { method: 'POST', headers: { Authorization: 'Bearer S' }, body: JSON.stringify({ label: 'Minton', instructions: 'x', folderPath: 'T:\\Minton' }) }), env))
  const rec = JSON.parse(env._kv.get(`ur:${r.token}`))
  check('create persists folderPath on the record', rec.folderPath === 'T:\\Minton', rec.folderPath)
}
{
  const env = kvEnv()
  await handleCreateUploadRequest(new Request('https://x/create', { method: 'POST', headers: { Authorization: 'Bearer S' }, body: JSON.stringify({ label: 'NoPath' }) }), env)
  const rec = JSON.parse([...env._kv.values()][0])
  check('create without folderPath stores none (not undefined string)', !('folderPath' in rec), JSON.stringify(rec))
}

console.log('\nhandleSetUploadFolder — backfill\n' + '='.repeat(64))
{
  const env = kvEnv({ 'ur:T': { label: 'Legacy', expiresAt: Date.now() + 1e9, createdAt: Date.now() } })
  check('setter refuses without auth', (await handleSetUploadFolder('T', new Request('https://x', { method: 'POST', body: '{}' }), env)).status === 401)
  const r = await handleSetUploadFolder('T', authed('POST', { folderPath: 'T:\\Backfilled' }), env)
  check('setter returns ok', (await bodyOf(r)).ok === true)
  check('  ...and writes folderPath onto the existing record', JSON.parse(env._kv.get('ur:T')).folderPath === 'T:\\Backfilled')
  check('setter 400s on empty folderPath', (await handleSetUploadFolder('T', authed('POST', { folderPath: '' }), env)).status === 400)
  check('setter 404s on unknown token', (await handleSetUploadFolder('NOPE', authed('POST', { folderPath: 'x' }), env)).status === 404)
}

console.log('\nhandleInbox returns folderPath (and "" when absent)\n' + '='.repeat(64))
{
  const env = kvEnv({
    'ur:A': { label: 'HasPath', folderPath: 'T:\\A', expiresAt: Date.now() + 1e9, createdAt: 2 },
    'ur:B': { label: 'NoPath', expiresAt: Date.now() + 1e9, createdAt: 1 },
  })
  check('inbox refuses without auth', (await handleInbox(new Request('https://x/inbox'), env)).status === 401)
  const b = await bodyOf(await handleInbox(authed('GET'), env))
  const A = b.requests.find(r => r.token === 'A'), B = b.requests.find(r => r.token === 'B')
  check('request with a folderPath reports it', A.folderPath === 'T:\\A', A.folderPath)
  check('request without one reports empty string, not undefined', B.folderPath === '', JSON.stringify(B.folderPath))
}

console.log('\ndecodeEntities — the submitted .txt no longer shows raw entities\n' + '='.repeat(64))
{
  check("W&#8209;2 and &#39; decode", decodeEntities('Kelly&#39;s W&#8209;2') === "Kelly's W\u20112", decodeEntities('Kelly&#39;s W&#8209;2'))
  check('&mdash; decodes', decodeEntities('a &mdash; b') === 'a \u2014 b')
  check('&amp; is decoded last (no double-decode)', decodeEntities('AT&amp;#38;T') === 'AT&#38;T')
  check('&amp;#8209; stays a literal entity, not a hyphen', decodeEntities('x &amp;#8209; y') === 'x &#8209; y')
  check('plain text passes through', decodeEntities('nothing to do') === 'nothing to do')
}

console.log('\n' + '='.repeat(64))
console.log(failed ? `${passed} passed, ${failed} FAILED` : `ALL ${passed} CHECKS PASSED`)
process.exit(failed ? 1 : 0)
