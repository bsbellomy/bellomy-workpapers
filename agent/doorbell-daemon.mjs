// Bellomy Workpapers — job doorbell daemon
//
// Runs as a Windows service (see scripts/install-doorbell-service.ps1) so job
// pickup does not depend on a Claude session being open. It holds the Worker's
// WebSocket doorbell and dispatches what it is allowed to dispatch.
//
// WHY A DAEMON AT ALL
// The desktop session used to be the only thing holding the socket. When it
// restarted, nothing was listening, and a job sat queued until the agent's
// fallback poll woke up — that is what cost a real job 10.8 minutes. A service
// survives restarts, reboots and crashes; NSSM restarts it if it dies.
//
// WHAT IT MAY RUN (Billy, 2026-10-01)
//   guide    -> run headless, end to end. The deliverable is an INTERNAL
//               preparer document, so a bad one costs review time, not client
//               trust.
//   request  -> NEVER run unattended. It publishes a client-facing worksheet
//               link. Leave it queued and say so; a human starts it.
//   return   -> NEVER run headless. The UltraTax RPA needs computer-use, which
//               only exists inside a desktop Claude session.
//
// ONE JOB AT A TIME is enforced globally: the daemon refuses to claim anything
// while any job is already `running`, whoever owns it.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const CFG = JSON.parse(readFileSync(join(HERE, 'config.local.json'), 'utf8'))

const BASE = (process.env.BW_WORKER_URL || CFG.workerUrl || 'https://share.bellomycpa.com').replace(/\/$/, '')
const SECRET = process.env.BW_UPLOAD_SECRET || CFG.uploadSecret
const WS_URL = BASE.replace(/^http/, 'ws') + '/job-events'
const CLAUDE = process.env.BW_CLAUDE_BIN || CFG.claudeBin || 'claude'

const PING_MS = 25000        // the edge drops an idle socket; the DO answers "ping" with "pong"
const SWEEP_MS = 10 * 60e3   // backstop only, for a frame missed during a reconnect — NOT the mechanism
const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000]

// Which process types this daemon may run with nobody watching.
const AUTO_RUN = new Set(['guide'])
const REPO_FOR = {
  guide: 'D:\\Projects\\taxguide-builder',
  request: 'D:\\Projects\\request-builder',
  return: 'D:\\Projects\\taxguide-builder',
}

const LOG_DIR = join(REPO, 'logs')
try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
const LOG = join(LOG_DIR, 'doorbell.log')

function log(...parts) {
  const line = `${new Date().toISOString()}  ${parts.join(' ')}`
  try { appendFileSync(LOG, line + '\n') } catch {}
  process.stdout.write(line + '\n')
}

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`)
  try { return JSON.parse(text) } catch { return { ok: false, raw: text } }
}

const setStatus = (id, status, note) => api('POST', `/job/${id}/status`, { status, note })
const findJob = async id => ((await api('GET', '/jobs')).jobs || []).find(j => j.id === id) || null
const AGENT = `doorbell-daemon@${process.env.COMPUTERNAME || 'unknown'}`

// ── dispatch ────────────────────────────────────────────────────────────────
let busy = false
const announced = new Set()   // job ids we have already said "waiting for a human" about

// KV is eventually consistent: a read issued the instant the doorbell fires can
// still miss the job that caused it. Observed in testing — the frame arrived,
// /jobs came back empty, and the job would have waited for the sweep, which is
// exactly the delay this daemon exists to remove. So a doorbell dispatch looks
// again a few times before concluding there is nothing to do.
const LOOK_AGAIN = { doorbell: 6 }
const LOOK_GAP_MS = 1500

async function dispatch(why) {
  if (busy) return
  busy = true
  try {
    let jobs = []
    const attempts = LOOK_AGAIN[why] || 1
    for (let i = 0; i < attempts; i++) {
      ;({ jobs = [] } = await api('GET', '/jobs'))
      if (jobs.some(j => j.status === 'queued' || j.status === 'running')) break
      if (i < attempts - 1) await new Promise(r => setTimeout(r, LOOK_GAP_MS))
    }
    if (why === 'doorbell' && !jobs.some(j => j.status === 'queued')) {
      log('[doorbell] frame received but no queued job appeared after ' +
          `${attempts} looks — already claimed elsewhere, or KV is lagging badly`)
    }

    // Global one-at-a-time. If anything is running — this daemon, a desktop
    // session, another machine — we keep our hands off.
    const running = jobs.find(j => j.status === 'running')
    if (running) { log(`[${why}] a job is already running (${running.id}); standing down`); return }

    const queued = jobs.filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
    if (!queued.length) return

    // Say once, per job, that a human has to start it. These do NOT block the
    // auto-runnable jobs behind them — that is what the claim filter is for.
    for (const j of queued.filter(j => !AUTO_RUN.has(j.process))) {
      if (announced.has(j.id)) continue
      announced.add(j.id)
      log(`[${why}] job ${j.id} (${j.process}, ${j.client}) NEEDS A HUMAN — ` +
          (j.process === 'return'
            ? 'the UltraTax RPA needs computer-use, so it must run in the desktop app'
            : 'a request job publishes a client-facing worksheet; left queued on purpose'))
    }

    if (!queued.some(j => AUTO_RUN.has(j.process))) return

    // Claim the oldest job OF A TYPE WE MAY RUN. Without the filter the claim
    // takes the oldest queued job of any type, so a request or return job
    // parked at the head of the queue would block every guide behind it.
    const { job } = await api('POST', '/claim-job', { agent: AGENT, processes: [...AUTO_RUN] })
    if (!job) return
    if (!AUTO_RUN.has(job.process)) {
      log(`claimed ${job.id} but it is a ${job.process} job — releasing it back to the queue`)
      await setStatus(job.id, 'queued', 'released by doorbell daemon: not auto-runnable')
      return
    }

    log(`[${why}] running ${job.process} job ${job.id} — ${job.client} ${job.year}`)
    const code = await runHeadless(job)

    // The run marks its own status. If it died without doing so, say so loudly
    // rather than leaving the job stuck in `running` forever.
    const after = await findJob(job.id).catch(() => null)
    const stillRunning = after ? after.status === 'running' : true
    if (stillRunning) {
      await setStatus(job.id, 'error',
        `headless run exited ${code} without reporting status — see logs/doorbell.log`)
      log(`job ${job.id} FAILED: exit ${code}, status not reported`)
    } else {
      log(`job ${job.id} finished, exit ${code}`)
    }
  } catch (e) {
    log('dispatch error:', e.message)
  } finally {
    busy = false
  }
}

function runHeadless(job) {
  const cwd = REPO_FOR[job.process] || REPO
  const prompt = [
    `You are running as an unattended background agent. Nobody is watching, so do not ask questions —`,
    `make the careful call a colleague would and write down what you assumed.`,
    ``,
    `Job ${job.id} has ALREADY BEEN CLAIMED for you. Do not claim another one.`,
    `Follow the run-next-job skill from step 3 onward (the claim is done), and obey the skill its`,
    `prompt names, end to end, including reading that skill and its references in full first.`,
    ``,
    `--- job prompt, verbatim ---`,
    job.prompt,
    `--- end job prompt ---`,
    ``,
    `Client: ${job.client}   Year: ${job.year}   Path: ${job.path}   Requester: ${job.requester}`,
    ``,
    `When you are finished you MUST report status yourself:`,
    `  node "${REPO}\\agent\\job-cli.mjs" status ${job.id} done "<one-line result>"`,
    `or, if you could not finish:`,
    `  node "${REPO}\\agent\\job-cli.mjs" status ${job.id} error "<why>"`,
  ].join('\n')

  return new Promise(resolve => {
    const child = spawn(CLAUDE, ['-p', prompt, '--permission-mode', 'acceptEdits'], {
      cwd, shell: true, windowsHide: true,
      env: { ...process.env, BW_HEADLESS: '1' },
    })
    child.stdout.on('data', d => log('  | ' + String(d).trimEnd()))
    child.stderr.on('data', d => log('  ! ' + String(d).trimEnd()))
    child.on('error', e => { log('spawn failed:', e.message); resolve(-1) })
    child.on('close', code => resolve(code ?? -1))
  })
}

// ── doorbell ────────────────────────────────────────────────────────────────
async function token() {
  const r = await api('GET', '/job-events/token')
  if (!r.protocol) throw new Error('token endpoint returned no protocol')
  return r.protocol
}

function hold(proto) {
  return new Promise(resolve => {
    let ws, timer
    try { ws = new WebSocket(WS_URL, [proto]) } catch (e) { return resolve('open failed: ' + e.message) }
    const shut = why => { clearInterval(timer); try { ws.close() } catch {} ; resolve(why) }

    ws.addEventListener('open', () => {
      log('doorbell connected')
      failures = 0
      timer = setInterval(() => { try { ws.send('ping') } catch {} }, PING_MS)
      dispatch('connect')          // catch anything queued while we were away
    })
    ws.addEventListener('message', ev => {
      const body = typeof ev.data === 'string' ? ev.data.trim() : ''
      if (!body || body === 'pong') return
      log('doorbell frame:', body)
      dispatch('doorbell')
    })
    ws.addEventListener('error', () => shut('error'))
    ws.addEventListener('close', ev => shut(`closed ${ev.code || 1006}`))
  })
}

let failures = 0

if (typeof WebSocket === 'undefined') {
  log('FATAL: this node build has no global WebSocket (need node >= 22)')
  process.exit(1)
}

setInterval(() => dispatch('sweep'), SWEEP_MS)
log(`doorbell daemon starting — worker ${BASE}, auto-run: ${[...AUTO_RUN].join(',') || 'nothing'}`)

for (;;) {
  let why
  try { why = await hold(await token()) } catch (e) { why = 'token: ' + e.message }
  failures++
  if (failures === 4) log(`doorbell degraded: repeated reconnect failures (${why})`)
  await new Promise(r => setTimeout(r, BACKOFF[Math.min(failures, BACKOFF.length - 1)]))
}
