// renderer-smoke.js — headless mount smoke test for the built renderer.
//
// Loads dist/renderer/index.html in a hidden BrowserWindow with NO preload, so
// window.electronAPI is undefined and the app's `api?.*` mount effects all
// no-op (no IPC, no drive access, no TaxDome launch). It then verifies React
// actually commits DOM into #root — i.e. the bundle parsed, executed, and
// mounted. This catches a renderer bundle that builds but throws on boot,
// without the side effects of launching the real app.
//
// Result is signalled via EXIT CODE (0 = mounted, 1 = failed) because Electron's
// Windows GUI build does not reliably attach stdout to the parent console.
// A human-readable line is also written to SMOKE_RESULT_FILE for diagnostics.

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const INDEX = path.join(ROOT, 'dist', 'renderer', 'index.html')
// Default into the OS temp dir (not the repo) so ship.ps1's `git add -A`
// never stages a stray result file.
const RESULT_FILE = process.env.SMOKE_RESULT_FILE || path.join(os.tmpdir(), 'renderer-smoke.result.txt')
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 30000
const POLL_MS = 250

// Software rendering — no GPU on headless/RDP build machines.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

let done = false
function finish(code, message) {
  if (done) return
  done = true
  try { fs.writeFileSync(RESULT_FILE, message + '\n') } catch (_) { /* best effort */ }
  app.exit(code)
}

app.whenReady().then(() => {
  if (!fs.existsSync(INDEX)) {
    finish(1, 'renderer-smoke: FAILED - built index.html not found at ' + INDEX)
    return
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    // No preload on purpose: exercise a clean mount with api === undefined.
  })

  // Keep the test hermetic: block the Tailwind CDN <script> so a slow/absent
  // network can't stall HTML parsing (and thus the deferred React module).
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['*://cdn.tailwindcss.com/*'] },
    (_details, cb) => cb({ cancel: true })
  )

  const errors = []
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3) errors.push('console: ' + msg)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    finish(1, 'renderer-smoke: FAILED - render process gone: ' + JSON.stringify(details))
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) {
      finish(1, 'renderer-smoke: FAILED - did-fail-load ' + code + ' ' + desc + ' ' + url)
    }
  })

  const deadline = Date.now() + TIMEOUT_MS
  async function poll() {
    if (done) return
    let count = 0
    try {
      count = await win.webContents.executeJavaScript(
        "(document.getElementById('root') && document.getElementById('root').children.length) || 0"
      )
    } catch (_) {
      count = 0 // page context not ready yet
    }
    if (count > 0) {
      finish(0, 'renderer-smoke: OK - #root mounted with ' + count + ' child node(s)')
      return
    }
    if (Date.now() > deadline) {
      finish(1, 'renderer-smoke: FAILED - #root still empty after ' + (TIMEOUT_MS / 1000) + 's'
        + (errors.length ? '; errors: ' + errors.slice(0, 5).join(' | ') : ''))
      return
    }
    setTimeout(poll, POLL_MS)
  }

  win.loadFile(INDEX)
  setTimeout(poll, POLL_MS)
})

// Do not exit just because the hidden window closed; finish() owns exit.
app.on('window-all-closed', () => { /* no-op */ })
