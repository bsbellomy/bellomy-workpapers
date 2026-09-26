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
  'export { handleJobCreate, handleJobList, handleJobClaim, handleJobStatus, handleJobDelete, handleJobTemplatesGet, handleJobTemplatesSet, DEFAULT_JOB_TEMPLATES, JOB_MAX_PROMPT }'
))
const {
  handleJobCreate, handleJobList, handleJobClaim, handleJobStatus,
  handleJobDelete, handleJobTemplatesGet, handleJobTemplatesSet,
  DEFAULT_JOB_TEMPLATES, JOB_MAX_PROMPT,
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

console.log('\n' + '='.repeat(64))
console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${pass} passed, ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
