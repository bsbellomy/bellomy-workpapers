// Offline test for the worksheet-state handlers.
//
//   node cloudflare-worker/worksheet.test.mjs
//
// POST /worksheet/:token is UNAUTHENTICATED — the 16-char token is the only
// credential — so its input validation is a security boundary, not a nicety.
// These checks prove the body is bounded and typed before anything is stored,
// that answers survive a save/resume round trip, that a dead token cannot be
// written to, and that GET /inbox never leaks without the secret.
//
// Fakes R2 + KV with the same surface the worker uses.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'worker.js'), 'utf8')

// Pull the worksheet block out of worker.js without running the fetch handler.
const capMatch = src.match(/^const WS_MAX_BYTES = \d+/m)
const block = src.slice(src.indexOf('const WS_CORS = {'), src.indexOf('\nfunction escapeHtml'))
if (!capMatch || !block) throw new Error('could not extract the worksheet block from worker.js')

const mod = await import('data:text/javascript,' + encodeURIComponent(
  capMatch[0] + '\n' +
  "function auth(request, env) { return request.headers.get('Authorization') === `Bearer ${env.UPLOAD_SECRET}` }\n" +
  block + '\n' +
  'export { handleWorksheetLoad, handleWorksheetSave, handleInbox, renderTranscript, WS_MAX_BYTES }'
))
const { handleWorksheetLoad, handleWorksheetSave, handleInbox, WS_MAX_BYTES } = mod

const SECRET = 'test-secret'
const DAY = 86400000

function makeEnv(kvRecords = {}, objects = {}) {
  const kv = new Map(Object.entries(kvRecords).map(([k, v]) => [k, JSON.stringify(v)]))
  const r2 = new Map(Object.entries(objects))
  return {
    UPLOAD_SECRET: SECRET,
    _r2: r2,
    LINKS_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null },
      async delete(k) { kv.delete(k) },
      async list({ prefix }) {
        return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }
      },
    },
    MAGIC_LINKS_BUCKET: {
      async get(k) {
        if (!r2.has(k)) return null
        const o = r2.get(k)
        return { async text() { return o.body }, body: o.body }
      },
      async head(k) { return r2.has(k) ? { customMetadata: r2.get(k).customMetadata || {} } : null },
      async put(k, body, opts = {}) { r2.set(k, { body, uploaded: new Date().toISOString(), size: String(body).length, ...opts }) },
      async delete(k) { r2.delete(k) },
      async list({ prefix }) {
        return { objects: [...r2.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size || 0, uploaded: o.uploaded })) }
      },
    },
  }
}

const post = body => new Request('https://x/worksheet/T', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const authed = tok => new Request('https://x/inbox', { headers: tok ? { Authorization: `Bearer ${tok}` } : {} })
const live = { label: 'Koller 2025 worksheet', expiresAt: Date.now() + 30 * DAY, createdAt: Date.now() - DAY }
const dead = { label: 'Old worksheet', expiresAt: Date.now() - DAY, createdAt: Date.now() - 100 * DAY }

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')) }
}
const bodyOf = async r => JSON.parse(await r.text())

console.log('\nPOST /worksheet/:token — input validation\n' + '='.repeat(64))
{
  const env = makeEnv({ 'ur:T': live })
  const r = await handleWorksheetSave('T', post('not json at all'), env)
  check('rejects non-JSON with 400', r.status === 400)
  check('  ...and stores nothing', !env._r2.has('ws/T.json'))
}
{
  const env = makeEnv({ 'ur:T': live })
  const r = await handleWorksheetSave('T', post('[1,2,3]'), env)
  check('rejects a JSON array with 400', r.status === 400, String(r.status))
}
{
  const env = makeEnv({ 'ur:T': live })
  const r = await handleWorksheetSave('T', post('null'), env)
  check('rejects JSON null with 400', r.status === 400, String(r.status))
}
{
  const env = makeEnv({ 'ur:T': live })
  const big = JSON.stringify({ answers: { q: 'x'.repeat(WS_MAX_BYTES) } })
  const r = await handleWorksheetSave('T', post(big), env)
  check(`rejects a payload over ${WS_MAX_BYTES} bytes with 413`, r.status === 413, String(r.status))
  check('  ...and stores nothing', !env._r2.has('ws/T.json'))
}
{
  const env = makeEnv({ 'ur:T': live })
  const r = await handleWorksheetSave('T', post({ answers: 'a string, not an object', total: 5 }), env)
  const b = await bodyOf(r)
  check('coerces a non-object answers field to empty rather than storing it', r.status === 200 && b.answered === 0)
}
{
  const env = makeEnv({ 'ur:T': live })
  const r = await handleWorksheetSave('T', post({ answers: { a: '1' }, total: 'lots' }), env)
  const b = await bodyOf(r)
  check('coerces a non-numeric total to 0', b.total === 0, JSON.stringify(b))
}

console.log('\nExpiry — a dead token is inert\n' + '='.repeat(64))
{
  const env = makeEnv({ 'ur:T': dead })
  const r = await handleWorksheetSave('T', post({ answers: { a: '1' }, total: 1 }), env)
  check('save against an EXPIRED record returns 410', r.status === 410)
  check('  ...and writes nothing to storage', env._r2.size === 0)
}
{
  const env = makeEnv({})
  const r = await handleWorksheetLoad('T', env)
  check('load against an UNKNOWN token returns 410', r.status === 410)
}
{
  const env = makeEnv({ 'ur:T': dead }, { 'ws/T.json': { body: JSON.stringify({ answers: { secret: 'value' } }) } })
  const r = await handleWorksheetLoad('T', env)
  const b = await bodyOf(r)
  check('load against an EXPIRED record does NOT return stored answers', r.status === 410 && !JSON.stringify(b).includes('secret'))
}

console.log('\nSave → resume round trip\n' + '='.repeat(64))
{
  const env = makeEnv({ 'ur:T': live })
  const answers = { 'Farm — feed purchased': '4074.25', 'Farm — miles driven': '7356', 'Construction — 1099s issued': 'No' }
  const save = await handleWorksheetSave('T', post({ answers, total: 57 }), env)
  const sb = await bodyOf(save)
  check('save returns ok with a count', sb.ok === true && sb.answered === 3 && sb.total === 57)

  const load = await handleWorksheetLoad('T', makeEnv({ 'ur:T': live }, Object.fromEntries(env._r2)))
  const lb = await bodyOf(load)
  check('resume returns every answer verbatim', JSON.stringify(lb.answers) === JSON.stringify(answers), JSON.stringify(lb.answers))
  check('resume reports progress', lb.answered === 3 && lb.total === 57)
  check('resume is not marked submitted', lb.submitted === false)
  check('answers are never cached', load.headers.get('Cache-Control') === 'no-store, private')
  check('local-file origin can read it (CORS)', load.headers.get('Access-Control-Allow-Origin') === '*')
}
{
  const env = makeEnv({ 'ur:T': live })
  const r = await handleWorksheetLoad('T', env)
  const b = await bodyOf(r)
  check('first visit with nothing saved is ok:true, not an error', r.status === 200 && b.ok === true && b.answered === 0)
}

console.log('\nSubmit — raises the existing Workpapers badge\n' + '='.repeat(64))
{
  const env = makeEnv({ 'ur:T': live })
  await handleWorksheetSave('T', post({ answers: { a: '1' }, total: 2, submitted: true, text: 'MY TRANSCRIPT' }), env)
  const dropped = [...env._r2.keys()].filter(k => k.startsWith('ur/T/'))
  check('submit writes a transcript into the FILE inbox', dropped.length === 1, dropped.join(','))
  check('  ...using the page-supplied text', env._r2.get(dropped[0]).body === 'MY TRANSCRIPT')
  check('  ...named after the request label', dropped[0].includes('Koller 2025 worksheet'))
  check('submit flag lands in customMetadata for the digest', env._r2.get('ws/T.json').customMetadata.submitted === '1')
}
{
  const env = makeEnv({ 'ur:T': live })
  await handleWorksheetSave('T', post({ answers: { a: '1' }, total: 2 }), env)
  check('a plain autosave does NOT drop a file (no false badge)', ![...env._r2.keys()].some(k => k.startsWith('ur/T/')))
}
{
  const env = makeEnv({ 'ur:T': live })
  await handleWorksheetSave('T', post({ answers: { 'Feed': '100' }, total: 1, submitted: true }), env)
  const f = [...env._r2.keys()].find(k => k.startsWith('ur/T/'))
  check('falls back to a generated transcript when the page sends no text', env._r2.get(f).body.includes('Feed: 100'))
}
{
  const env = makeEnv({ 'ur:T': { ...live, label: 'Bad/Name:*?<>|' } })
  await handleWorksheetSave('T', post({ answers: { a: '1' }, total: 1, submitted: true }), env)
  const f = [...env._r2.keys()].find(k => k.startsWith('ur/T/'))
  check('sanitises a hostile label out of the stored filename', !/[/:*?<>|]/.test(f.slice('ur/T/'.length)), f)
}
{
  const env = makeEnv({ 'ur:T': live })
  await handleWorksheetSave('T', post({ answers: { a: '1' }, total: 3 }), env)
  await handleWorksheetSave('T', post({ answers: { a: '1', b: '2' }, total: 3 }), env)
  const b = JSON.parse(env._r2.get('ws/T.json').body)
  check('repeated autosaves overwrite one object, never accumulate', b.answered === 2 && [...env._r2.keys()].filter(k => k.startsWith('ws/')).length === 1)
}

console.log('\nGET /inbox\n' + '='.repeat(64))
{
  const env = makeEnv({ 'ur:T': live })
  check('refuses without the secret', (await handleInbox(authed(null), env)).status === 401)
  check('refuses with the wrong secret', (await handleInbox(authed('nope'), env)).status === 401)
}
{
  const env = makeEnv({ 'ur:A': live, 'ur:B': { ...live, label: 'Second', createdAt: Date.now() } })
  await handleWorksheetSave('A', post({ answers: { a: '1', b: '2' }, total: 10 }), env)
  await env.MAGIC_LINKS_BUCKET.put('ur/A/receipt.pdf', 'x')
  const b = await bodyOf(await handleInbox(authed(SECRET), env))
  const a = b.requests.find(r => r.token === 'A')
  check('lists every live request', b.count === 2, JSON.stringify(b.count))
  check('reports worksheet progress without reading the body', a.worksheet.answered === 2 && a.worksheet.total === 10)
  check('reports uploaded files', a.files.length === 1 && a.files[0].name === 'receipt.pdf')
  check('reports a request with no worksheet as null', b.requests.find(r => r.token === 'B').worksheet === null)
  check('reports days remaining', a.daysLeft > 0 && a.daysLeft <= 30)
  check('newest request first', b.requests[0].token === 'B')
}

console.log('\n' + '='.repeat(64))
console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${pass} passed, ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
