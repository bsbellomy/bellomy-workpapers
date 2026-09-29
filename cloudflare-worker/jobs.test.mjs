// Offline test for the agent job-queue handlers.
//
//   node cloudflare-worker/jobs.test.mjs
//
// Every job endpoint is auth-gated (Bearer UPLOAD_SECRET): a job drives an
// autonomous session on the dev box, so enqueueing or reading one without the
// firm secret must be impossible. These checks prove the auth wall holds, that a
// job round-trips through create → claim → status, that FIFO claim order is kept,
// that only one agent can claim a given job, that cancel is refused once a job is
// running, and that templates fall back to the built-in defaults.
//
// Fakes KV with the same surface the worker uses.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'worker.js'), 'utf8')

const start = src.indexOf('// ==JOBS_BLOCK_START==')
const end = src.indexOf('// ==JOBS_BLOCK_END==')
if (start < 0 || end < 0) throw new Error('could not find the jobs block markers in worker.js')
const block = src.slice(start, end)

// Provide the small worker-level helpers the block depends on.
const preamble = `
let __n = 0
function shortId() { return 'job' + (++__n).toString().padStart(6, '0') }
function auth(request, env) { return request.headers.get('Authorization') === 'Bearer ' + env.UPLOAD_SECRET }
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}
`
const mod = await import('data:text/javascript,' + encodeURIComponent(
  preamble + block + '\n' +
  'export { handleJobCreate, handleJobList, handleJobClaim, handleJobStatus, handleJobDelete, handleJobTemplatesGet, handleJobTemplatesSet, DEFAULT_JOB_TEMPLATES, JOB_MAX_PROMPT, handleJobSubToken, handleJobEvents, notifyJobQueued, jobSubToken, timingSafeEqual, JOB_WS_PROTO }'
))
const {
  handleJobCreate, handleJobList, handleJobClaim, handleJobStatus,
  handleJobDelete, handleJobTemplatesGet, handleJobTemplatesSet,
  DEFAULT_JOB_TEMPLATES, JOB_MAX_PROMPT,
  handleJobSubToken, handleJobEvents, notifyJobQueued, jobSubToken,
  timingSafeEqual, JOB_WS_PROTO, JobNotifier,
} = mod

const SECRET = 'test-secret'

function makeEnv() {
  const kv = new Map()
  return {
    UPLOAD_SECRET: SECRET,
    _kv: kv,
    LINKS_KV: {
      async get(k) { return kv.has(k) ? kv.get(k) : null },
      async put(k, v) { kv.set(k, v) },
      async delete(k) { kv.delete(k) },
      async list({ prefix, cursor }) {
        const keys = [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }))
        return { keys, list_complete: true, cursor }
      },
    },
  }
}

const req = (method, body, tok = SECRET) => new Request('https://x/job', {
  method,
  headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
})
const bodyOf = async r => JSON.parse(await r.text())

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')) }
}

console.log('\nAuth wall — every endpoint refuses without the secret\n' + '='.repeat(64))
{
  const env = makeEnv()
  check('create refuses without secret', (await handleJobCreate(req('POST', { process: 'guide', prompt: 'x' }, null), env)).status === 401)
  check('create refuses wrong secret', (await handleJobCreate(req('POST', { process: 'guide', prompt: 'x' }, 'nope'), env)).status === 401)
  check('list refuses without secret', (await handleJobList(req('GET', undefined, null), env)).status === 401)
  check('claim refuses without secret', (await handleJobClaim(req('POST', undefined, null), env)).status === 401)
  check('status refuses without secret', (await handleJobStatus('id', req('POST', { status: 'done' }, null), env)).status === 401)
  check('delete refuses without secret', (await handleJobDelete('id', req('DELETE', undefined, null), env)).status === 401)
  check('templates GET refuses without secret', (await handleJobTemplatesGet(req('GET', undefined, null), env)).status === 401)
  check('templates POST refuses without secret', (await handleJobTemplatesSet(req('POST', {}, null), env)).status === 401)
  check('  ...and nothing was written', env._kv.size === 0)
}

console.log('\nCreate — validation\n' + '='.repeat(64))
{
  const env = makeEnv()
  check('rejects an unknown process', (await handleJobCreate(req('POST', { process: 'nope', prompt: 'x' }), env)).status === 400)
  check('rejects an empty prompt', (await handleJobCreate(req('POST', { process: 'guide', prompt: '   ' }), env)).status === 400)
  const big = 'x'.repeat(JOB_MAX_PROMPT + 1)
  check('rejects an over-long prompt with 413', (await handleJobCreate(req('POST', { process: 'guide', prompt: big }), env)).status === 413)
  check('  ...and stored nothing', env._kv.size === 0)
}

console.log('\nCreate → list → claim → done round trip\n' + '='.repeat(64))
{
  const env = makeEnv()
  const c = await bodyOf(await handleJobCreate(req('POST', {
    process: 'return', prompt: 'Prep 2025 return', client: 'Cluck, Robert', path: 'T:\\Cluck', year: '2025', requester: 'billy@BOX',
  }), env))
  check('create returns ok + id', c.ok === true && !!c.id)
  check('  ...status starts queued', c.job.status === 'queued')
  check('  ...client/path/year/requester preserved', c.job.client === 'Cluck, Robert' && c.job.path === 'T:\\Cluck' && c.job.year === '2025' && c.job.requester === 'billy@BOX')

  const list = await bodyOf(await handleJobList(req('GET'), env))
  check('list shows the queued job', list.count === 1 && list.jobs[0].id === c.id)

  const claim = await bodyOf(await handleJobClaim(req('POST', { agent: 'devbox' }), env))
  check('claim returns the job', claim.job && claim.job.id === c.id)
  check('  ...marked running with agent + claimedAt', claim.job.status === 'running' && claim.job.agent === 'devbox' && !!claim.job.claimedAt)

  const done = await bodyOf(await handleJobStatus(c.id, req('POST', { status: 'done', note: 'return filed' }), env))
  check('status → done sticks', done.job.status === 'done' && done.job.note === 'return filed')

  const claim2 = await bodyOf(await handleJobClaim(req('POST', { agent: 'devbox' }), env))
  check('nothing left to claim once drained', claim2.job === null)
}

console.log('\nFIFO + single-claim\n' + '='.repeat(64))
{
  const env = makeEnv()
  const a = await bodyOf(await handleJobCreate(req('POST', { process: 'guide', prompt: 'A' }), env))
  await new Promise(r => setTimeout(r, 2))
  const b = await bodyOf(await handleJobCreate(req('POST', { process: 'guide', prompt: 'B' }), env))
  const first = await bodyOf(await handleJobClaim(req('POST', {}), env))
  check('oldest job is claimed first', first.job.id === a.id, `${first.job.id} vs ${a.id}`)
  const second = await bodyOf(await handleJobClaim(req('POST', {}), env))
  check('a claimed job is never handed out again', second.job.id === b.id && second.job.id !== first.job.id)
  const third = await bodyOf(await handleJobClaim(req('POST', {}), env))
  check('queue is empty after both claimed', third.job === null)
}

console.log('\nCancel semantics\n' + '='.repeat(64))
{
  const env = makeEnv()
  const j = await bodyOf(await handleJobCreate(req('POST', { process: 'request', prompt: 'x' }), env))
  const cancel = await handleJobStatus(j.id, req('POST', { status: 'canceled' }), env)
  check('a QUEUED job can be canceled', cancel.status === 200 && (await bodyOf(cancel)).job.status === 'canceled')
  const claim = await bodyOf(await handleJobClaim(req('POST', {}), env))
  check('a canceled job is not claimable', claim.job === null)
}
{
  const env = makeEnv()
  const j = await bodyOf(await handleJobCreate(req('POST', { process: 'request', prompt: 'x' }), env))
  await handleJobClaim(req('POST', {}), env)   // now running
  const cancel = await handleJobStatus(j.id, req('POST', { status: 'canceled' }), env)
  check('a RUNNING job cannot be canceled (409)', cancel.status === 409)
}
{
  const env = makeEnv()
  const r = await handleJobStatus('does-not-exist', req('POST', { status: 'done' }), env)
  check('status on an unknown job is 404', r.status === 404)
  const bad = await handleJobStatus('x', req('POST', { status: 'sideways' }), makeEnv())
  check('an invalid status value is 400', bad.status === 400)
}

console.log('\nDelete clears a terminal job\n' + '='.repeat(64))
{
  const env = makeEnv()
  const j = await bodyOf(await handleJobCreate(req('POST', { process: 'guide', prompt: 'x' }), env))
  await handleJobDelete(j.id, req('DELETE'), env)
  const list = await bodyOf(await handleJobList(req('GET'), env))
  check('deleted job is gone from the list', list.count === 0)
}

console.log('\nTemplates\n' + '='.repeat(64))
{
  const env = makeEnv()
  const g = await bodyOf(await handleJobTemplatesGet(req('GET'), env))
  check('returns built-in defaults when none saved', g.templates.request === DEFAULT_JOB_TEMPLATES.request && !!g.templates.guide && !!g.templates.return)
  check('  ...defaults carry the placeholders', /\{\{client\}\}/.test(g.templates.request) && /\{\{year\}\}/.test(g.templates.guide) && /\{\{path\}\}/.test(g.templates.return))

  await handleJobTemplatesSet(req('POST', { guide: 'MY CUSTOM GUIDE {{client}}' }), env)
  const g2 = await bodyOf(await handleJobTemplatesGet(req('GET'), env))
  check('a saved template overrides its default', g2.templates.guide === 'MY CUSTOM GUIDE {{client}}')
  check('  ...unset templates still fall back to default', g2.templates.request === DEFAULT_JOB_TEMPLATES.request)
}

console.log('\nNo KV list() in the job paths (free-tier list cap is 1,000/day)\n' + '='.repeat(64))
{
  // Regression guard: the hot paths (poll = list + claim) must never call KV
  // list() — it is capped at 1,000 ops/day on the free tier and constant polling
  // exhausted it once. All job storage goes through a single get()/put() key.
  const env = makeEnv()
  let listCalls = 0
  env.LINKS_KV.list = async () => { listCalls++; throw new Error('KV list() must not be called from job endpoints') }
  const c = await bodyOf(await handleJobCreate(req('POST', { process: 'guide', prompt: 'x' }), env))
  await handleJobList(req('GET'), env)
  await handleJobClaim(req('POST', {}), env)
  await handleJobStatus(c.id, req('POST', { status: 'done' }), env)
  await handleJobList(req('GET'), env)
  await handleJobDelete(c.id, req('DELETE'), env)
  await handleJobTemplatesGet(req('GET'), env)
  check('create/list/claim/status/delete/templates make ZERO list() calls', listCalls === 0, `${listCalls} calls`)
}

// ── The job doorbell ─────────────────────────────────────────────────────────
// A WebSocket that tells the agent a job exists. It must stay a DOORBELL: the
// frame carries no prompt, client or path, so a leaked subscribe token reveals
// nothing. Claiming still goes through the Bearer-gated claim endpoint.

const wsReq = (proto, upgrade = true) => new Request('https://x/job-events', {
  headers: {
    ...(upgrade ? { Upgrade: 'websocket' } : {}),
    ...(proto ? { 'Sec-WebSocket-Protocol': proto } : {}),
  },
})

// A DO binding that records what was pushed, without a real Durable Object.
// The subscribe arm returns a bare {status:101} object rather than a Response:
// undici refuses to construct a 101 Response, though workerd allows it. The
// handler passes the DO's result straight through, so this still proves the
// request was authorised and delegated.
function fakeNotifier() {
  const sent = []
  return {
    sent,
    idFromName: () => 'jobs',
    get: () => ({
      async fetch(r) {
        if (new URL(r.url).pathname === '/broadcast') { sent.push(await r.text()); return new Response('{"ok":true}') }
        return { status: 101, chosenProtocol: r.headers.get('X-Chosen-Protocol') }
      },
    }),
  }
}

console.log('\nDoorbell — subscribe token\n' + '='.repeat(64))
{
  const env = makeEnv()
  check('token endpoint refuses without the secret',
    (await handleJobSubToken(req('GET', undefined, null), env)).status === 401)
  check('  ...and minted nothing', env._kv.size === 0)

  const first = await bodyOf(await handleJobSubToken(req('GET'), env))
  check('mints a token with the secret', first.ok === true && typeof first.token === 'string')
  check('token is 48 hex chars', /^[0-9a-f]{48}$/.test(first.token || ''), first.token)
  check('returns the ready-made subprotocol', first.protocol === JOB_WS_PROTO + first.token)
  const second = await bodyOf(await handleJobSubToken(req('GET'), env))
  check('minting is idempotent — same token on a second call', second.token === first.token)
}

console.log('\nDoorbell — who may subscribe\n' + '='.repeat(64))
{
  const env = makeEnv()
  env.JOB_NOTIFIER = fakeNotifier()
  check('refuses before any token exists',
    (await handleJobEvents(wsReq(JOB_WS_PROTO + 'deadbeef'), env)).status === 401)

  const { token } = await bodyOf(await handleJobSubToken(req('GET'), env))
  check('refuses a plain GET that is not an upgrade with 426',
    (await handleJobEvents(wsReq(JOB_WS_PROTO + token, false), env)).status === 426)
  check('refuses an upgrade with no subprotocol',
    (await handleJobEvents(wsReq(null), env)).status === 401)
  check('refuses a wrong token',
    (await handleJobEvents(wsReq(JOB_WS_PROTO + 'f'.repeat(48)), env)).status === 401)
  check('refuses a right token under the wrong prefix',
    (await handleJobEvents(wsReq('other-' + token), env)).status === 401)
  const ok = await handleJobEvents(wsReq(JOB_WS_PROTO + token), env)
  check('accepts the correct subprotocol', ok.status === 101)
  check('  ...and echoes the chosen protocol back to the client',
    ok.chosenProtocol === JOB_WS_PROTO + token)
  check('accepts when the agent offers several protocols',
    (await handleJobEvents(wsReq(`some-other, ${JOB_WS_PROTO}${token}`), env)).status === 101)
  check('the secret itself is NOT accepted as a subscribe token',
    (await handleJobEvents(wsReq(JOB_WS_PROTO + SECRET), env)).status === 401)
  check('timingSafeEqual rejects a length mismatch', timingSafeEqual('abc', 'abcd') === false)
  check('timingSafeEqual matches an identical string', timingSafeEqual(token, token) === true)
}

console.log('\nDoorbell — it rings, and it says nothing else\n' + '='.repeat(64))
{
  const env = makeEnv()
  env.JOB_NOTIFIER = fakeNotifier()
  const r = await handleJobCreate(req('POST', {
    process: 'guide', prompt: 'Build the guide for Magoon', client: 'Magoon, Steve & Ann',
    path: 'T:\\Magoon, Steve & Ann', year: '2025',
  }), env)
  check('enqueue succeeds', r.status === 200)
  check('exactly one frame was pushed', env.JOB_NOTIFIER.sent.length === 1, String(env.JOB_NOTIFIER.sent.length))
  const frame = env.JOB_NOTIFIER.sent[0] || ''
  const parsed = JSON.parse(frame || '{}')
  check('the frame says only that something was queued',
    parsed.event === 'job-queued' && typeof parsed.at === 'number' && Object.keys(parsed).length === 2, frame)
  check('the frame leaks NO client name', !/Magoon/i.test(frame), frame)
  check('the frame leaks NO folder path', !/T:\\\\|T:\\/.test(frame), frame)
  check('the frame leaks NO prompt', !/Build the guide/i.test(frame), frame)
  check('claiming still requires the secret',
    (await handleJobClaim(req('POST', undefined, null), env)).status === 401)
}

console.log('\nDoorbell — a broken doorbell never blocks a job\n' + '='.repeat(64))
{
  const env = makeEnv()                       // no JOB_NOTIFIER binding at all
  const r = await handleJobCreate(req('POST', { process: 'guide', prompt: 'x' }), env)
  check('enqueue succeeds with the binding absent', r.status === 200)
  check('notifyJobQueued reports false rather than throwing', (await notifyJobQueued(env)) === false)

  const env2 = makeEnv()
  env2.JOB_NOTIFIER = { idFromName: () => 'jobs', get: () => ({ fetch: async () => { throw new Error('DO down') } }) }
  const r2 = await handleJobCreate(req('POST', { process: 'guide', prompt: 'y' }), env2)
  check('enqueue still succeeds when the notifier throws', r2.status === 200)
  const b2 = await bodyOf(r2)
  const stored = JSON.parse(env2._kv.get('jobs') || '{}')
  check('  ...and the job is durably stored anyway', !!stored[b2.id] && stored[b2.id].status === 'queued')
  check('a claim then returns it', (await bodyOf(await handleJobClaim(req('POST', {}), env2))).job?.id === b2.id)
}

console.log('\nDoorbell — the JobNotifier object itself\n' + '='.repeat(64))
{
  // Exercise the real class, with a fake hibernation state.
  const live = { sent: [] }
  const dead = { sent: [] }
  const sockets = [
    { send(m) { live.sent.push(m) } },
    { send() { throw new Error('socket already closed') } },
    { send(m) { dead.sent.push(m) } },
  ]
  const state = { getWebSockets: () => sockets, acceptWebSocket() {} }
  const dobj = new JobNotifier(state, {})

  const res = await dobj.fetch(new Request('https://do/broadcast', { method: 'POST', body: '{"event":"job-queued","at":1}' }))
  const out = JSON.parse(await res.text())
  check('broadcast reaches every healthy socket', live.sent.length === 1 && dead.sent.length === 1)
  check('a dead socket does not stop the rest', out.delivered === 2, JSON.stringify(out))
  check('each socket got the doorbell frame verbatim', live.sent[0] === '{"event":"job-queued","at":1}')

  const notUpgrade = await dobj.fetch(new Request('https://do/subscribe'))
  check('the DO refuses a non-upgrade request with 426', notUpgrade.status === 426)

  let ponged = null
  await dobj.webSocketMessage({ send: m => { ponged = m } }, 'ping')
  check('ping is answered with pong', ponged === 'pong')
  let closedWith = null
  await dobj.webSocketClose({ close: (c) => { closedWith = c } }, 1000)
  check('close is passed through', closedWith === 1000)
  await dobj.webSocketClose({ close: () => { throw new Error('already gone') } }, 1000)
  check('closing an already-dead socket does not throw', true)
}

console.log('\nDoorbell — no new KV cost on the hot path\n' + '='.repeat(64))
{
  const env = makeEnv()
  env.JOB_NOTIFIER = fakeNotifier()
  let listCalls = 0
  env.LINKS_KV.list = async () => { listCalls++; throw new Error('KV list() must not be called') }
  await handleJobCreate(req('POST', { process: 'guide', prompt: 'x' }), env)
  await handleJobClaim(req('POST', {}), env)
  check('create + claim still make ZERO KV list() calls', listCalls === 0, `${listCalls} calls`)

  // The doorbell must not turn a poll into extra reads: claim is unchanged.
  let gets = 0
  const realGet = env.LINKS_KV.get.bind(env.LINKS_KV)
  env.LINKS_KV.get = async k => { gets++; return realGet(k) }
  await handleJobClaim(req('POST', {}), env)
  check('an empty claim is still a single KV get', gets === 1, `${gets} gets`)
}

console.log('\n' + '='.repeat(64))
console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${pass} passed, ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
