// Bellomy Workpapers — job queue CLI
//
// Thin client the run-next-job skill uses from inside a desktop Claude Code
// session to talk to the Worker's job queue. Keeps the UPLOAD_SECRET in one
// place (config.local.json / env) instead of scattering it through skill text.
//
//   node agent/job-cli.mjs list                     # all jobs (JSON)
//   node agent/job-cli.mjs claim                     # claim + return the oldest queued job (or {job:null})
//   node agent/job-cli.mjs status <id> <status> [note...]   # done | error | running | canceled
//   node agent/job-cli.mjs get <id>                  # one job
//
// Config (first hit wins): env BW_WORKER_URL / BW_UPLOAD_SECRET, else
// agent/config.local.json { workerUrl, uploadSecret }. Prints JSON to stdout so
// the skill can parse it; errors go to stderr with a non-zero exit.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { hostname, userInfo } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(join(here, 'config.local.json'), 'utf8')) } catch { /* env only */ }
  const workerUrl = (process.env.BW_WORKER_URL || cfg.workerUrl || 'https://share.bellomycpa.com').replace(/\/$/, '')
  const secret = process.env.BW_UPLOAD_SECRET || cfg.uploadSecret || ''
  return { workerUrl, secret }
}

function agentId() {
  let user = 'user'
  try { user = userInfo().username } catch { /* ignore */ }
  let host = ''
  try { host = hostname() } catch { /* ignore */ }
  return host ? `${user}@${host}` : user
}

// Throw rather than process.exit(): calling process.exit() while fetch's socket
// is still closing trips a libuv assertion on Windows. Let the event loop drain
// and set exitCode via the top-level catch instead.
function die(msg) { throw new Error(msg) }
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n') }

async function call(method, path, body) {
  const { workerUrl, secret } = loadConfig()
  if (!secret) die('No upload secret. Set BW_UPLOAD_SECRET or agent/config.local.json.')
  const resp = await fetch(`${workerUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  let json
  try { json = JSON.parse(text) } catch { json = { ok: false, raw: text } }
  if (!resp.ok) die(`HTTP ${resp.status}: ${text}`)
  return json
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'list':
      out(await call('GET', '/jobs'))
      break
    case 'claim':
      out(await call('POST', '/claim-job', { agent: agentId() }))   // { ok, job }; job is null when empty
      break
    case 'get': {
      if (!rest[0]) die('usage: get <id>')
      const r = await call('GET', '/jobs')
      out({ ok: true, job: (r.jobs || []).find(j => j.id === rest[0]) || null })
      break
    }
    case 'status': {
      const [id, status, ...noteParts] = rest
      if (!id || !status) die('usage: status <id> <done|error|running|canceled> [note...]')
      out(await call('POST', `/job/${id}/status`, { status, note: noteParts.join(' ') }))
      break
    }
    default:
      die('usage: node agent/job-cli.mjs <list|claim|get|status> ...')
  }
}

main().catch(err => { process.stderr.write((err?.message || String(err)) + '\n'); process.exitCode = 1 })
