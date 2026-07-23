import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron'
import { autoUpdater } from 'electron-updater'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = null // suppress to stderr; we surface status via IPC

// ── Scan inbox ────────────────────────────────────────────────────────────────
let mainWin: BrowserWindow | null = null
let scanWatcher: fs.FSWatcher | null = null

function scanInboxPath(): string {
  const p = path.join(app.getPath('userData'), 'scans')
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
  return p
}

function cleanScanInbox() {
  try {
    const inbox = scanInboxPath()
    for (const f of fs.readdirSync(inbox)) {
      try { fs.unlinkSync(path.join(inbox, f)) } catch {}
    }
  } catch {}
}

function stopScanWatcher() {
  if (scanWatcher) { try { scanWatcher.close() } catch {} scanWatcher = null }
}

function getScanHelperPath(): string {
  if (isDev) return path.join(app.getAppPath(), 'scanner', 'ScanHelper', 'bin', 'publish', 'ScanHelper.exe')
  return path.join(process.resourcesPath, 'scanner', 'ScanHelper.exe')
}

// Turn a raw fs error into a plain-English diagnosis of *why* a write to a
// network/TaxDome folder likely failed, so users don't have to guess between
// "file is open elsewhere," "no permission," and "antivirus is blocking it."
function diagnoseWriteFailure(destFolder: string, destFile: string, err: unknown): string {
  const base = String(err instanceof Error ? err.message : err)
  const code = (err as { code?: string })?.code
  if (fs.existsSync(destFile)) {
    try { const fd = fs.openSync(destFile, 'r+'); fs.closeSync(fd) }
    catch {
      return `The file "${path.basename(destFile)}" already exists at the destination and appears to be open in another program. Close it and try again. (${base})`
    }
  }
  try { fs.accessSync(destFolder, fs.constants.W_OK) }
  catch {
    return `This computer does not have write permission to "${destFolder}". This is usually a TaxDome folder-permission issue, not an app bug — check with your TaxDome admin, or try saving a test file there via File Explorer to confirm. (${base})`
  }
  if (code === 'EPERM') {
    return `Windows blocked the write to "${destFolder}" (EPERM) even though the folder looks writable. This is often antivirus "Controlled Folder Access" / ransomware protection silently blocking the app. Check Windows Security > Virus & threat protection > Ransomware protection > Controlled folder access, and allow "Bellomy Workpapers" if it's on. (${base})`
  }
  return base
}

ipcMain.handle('fs:testWriteAccess', async (_e, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) return { ok: false, error: `Folder does not exist or is not reachable: ${folderPath}` }
    const testFile = path.join(folderPath, `.bellomy-write-test-${Date.now()}.tmp`)
    fs.writeFileSync(testFile, 'test')
    fs.unlinkSync(testFile)
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: diagnoseWriteFailure(folderPath, folderPath, err) }
  }
})

let currentRootPath = 'Z:\\'

// ── App config file ───────────────────────────────────────────────────────────
function configPath() { return path.join(app.getPath('userData'), 'bellomy-config.json') }
function readConfig(): Record<string, unknown> {
  try { if (fs.existsSync(configPath())) return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch {}
  return {}
}
ipcMain.handle('fs:getConfig', (_e, key: string) => readConfig()[key] ?? null)
ipcMain.handle('fs:setConfig', (_e, key: string, value: unknown) => {
  try { const c=readConfig(); c[key]=value; fs.writeFileSync(configPath(), JSON.stringify(c,null,2),'utf8'); return true }
  catch { return false }
})

// ── Encrypted secrets (magic link Worker URL + upload secret) ────────────────
function secretsPath() { return path.join(app.getPath('userData'), 'bellomy-secrets.json') }
function readSecretsRaw(): Record<string, string> {
  try { if (fs.existsSync(secretsPath())) return JSON.parse(fs.readFileSync(secretsPath(), 'utf8')) } catch {}
  return {}
}
function readSecrets(): Record<string, string> {
  const raw = readSecretsRaw()
  const out: Record<string, string> = {}
  for (const k of Object.keys(raw)) {
    try { out[k] = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw[k], 'base64')) : raw[k] }
    catch { out[k] = '' }
  }
  return out
}
function writeSecret(key: string, value: string) {
  const raw = readSecretsRaw()
  raw[key] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : value
  fs.writeFileSync(secretsPath(), JSON.stringify(raw, null, 2), 'utf8')
}
ipcMain.handle('fs:setSecret', (_e, key: string, value: string) => {
  try { writeSecret(key, value); return true } catch { return false }
})
// Not a secret — just the default Worker endpoint. The upload secret itself is never hardcoded
// since this repo is public; it must be entered once in Settings and is stored encrypted.
const DEFAULT_WORKER_URL = 'https://share.bellomycpa.com'

ipcMain.handle('fs:getMagicLinkConfig', () => {
  const s = readSecrets()
  return { workerUrl: s.workerUrl || DEFAULT_WORKER_URL, hasUploadSecret: !!s.uploadSecret }
})

// ── Magic links: upload file(s) to the Cloudflare Worker, get back single-view links ──
function parsePageRanges(rangeStr: string, totalPages: number): number[] {
  const indices: number[] = []
  for (const part of rangeStr.split(',')) {
    const t = part.trim()
    const dash = t.indexOf('-')
    if (dash > 0) {
      const a = parseInt(t.slice(0, dash)) - 1
      const b = parseInt(t.slice(dash + 1)) - 1
      for (let i = Math.max(0, a); i <= Math.min(totalPages - 1, b); i++) indices.push(i)
    } else {
      const n = parseInt(t) - 1
      if (n >= 0 && n < totalPages) indices.push(n)
    }
  }
  return [...new Set(indices)].sort((a, b) => a - b)
}

ipcMain.handle('fs:sendMagicLinks', async (_e, items: { name: string; path?: string; bytes?: ArrayBuffer; pages?: string }[], expiresDays: number) => {
  const secrets = readSecrets()
  const workerUrl = (secrets.workerUrl || DEFAULT_WORKER_URL).replace(/\/$/, '')
  const uploadSecret = secrets.uploadSecret ?? ''
  if (!workerUrl || !uploadSecret) return { ok: false, error: 'Magic link is not configured. Set the upload secret in Settings.' }
  const results: { name: string; url?: string; error?: string }[] = []
  for (const item of items) {
    try {
      let data: Buffer = item.bytes ? Buffer.from(item.bytes) : fs.readFileSync(item.path!)
      if (item.pages && item.pages.trim() && item.path) {
        const { PDFDocument } = await import('pdf-lib')
        const srcDoc = await PDFDocument.load(data)
        const indices = parsePageRanges(item.pages, srcDoc.getPageCount())
        if (indices.length === 0) { results.push({ name: item.name, error: `No valid pages in range "${item.pages}"` }); continue }
        const outDoc = await PDFDocument.create()
        const copied = await outDoc.copyPages(srcDoc, indices)
        copied.forEach(p => outDoc.addPage(p))
        data = Buffer.from(await outDoc.save())
      }
      const resp = await fetch(`${workerUrl}/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${uploadSecret}`,
          'X-File-Name': encodeURIComponent(item.name),
          'X-Expires-Days': String(expiresDays),
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(data),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(()=>'')
        results.push({ name: item.name, error: `Upload failed (HTTP ${resp.status}): ${body}` }); continue
      }
      const json = await resp.json() as { url: string }
      results.push({ name: item.name, url: json.url })
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      results.push({ name: item.name, error: msg })
    }
  }
  return { ok: true, results }
})

// ── Upload requests: request files FROM clients ───────────────────────────────

function workerAuth() {
  const secrets = readSecrets()
  return {
    workerUrl: (secrets.workerUrl || DEFAULT_WORKER_URL).replace(/\/$/, ''),
    uploadSecret: secrets.uploadSecret ?? '',
  }
}

ipcMain.handle('fs:createUploadRequest', async (_e, label: string, instructions: string, expiresDays: number, folderPath: string) => {
  const { workerUrl, uploadSecret } = workerAuth()
  if (!uploadSecret) return { ok: false, error: 'Magic link is not configured.' }
  try {
    const resp = await fetch(`${workerUrl}/create-upload-request`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${uploadSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, instructions, expiresDays }),
    })
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const { token, url } = await resp.json() as { token: string; url: string }
    // Store token→folderPath mapping locally so we know where to save files
    type UReqs = Record<string, { label: string; folderPath: string; url: string; createdAt: string; expiresDays: number }>
    const cfg = readConfig()
    const requests: UReqs = (cfg.uploadRequests as UReqs) ?? {}
    requests[token] = { label, folderPath, url, createdAt: new Date().toISOString(), expiresDays }
    const merged = { ...cfg, uploadRequests: requests }
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8')
    return { ok: true, token, url }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:listUploadRequests', () => {
  const cfg = readConfig()
  return cfg.uploadRequests ?? {}
})

ipcMain.handle('fs:checkUploads', async (_e, token: string) => {
  const { workerUrl, uploadSecret } = workerAuth()
  if (!uploadSecret) return { ok: false, error: 'Not configured.' }
  try {
    const resp = await fetch(`${workerUrl}/check-uploads/${token}`, {
      headers: { 'Authorization': `Bearer ${uploadSecret}` },
    })
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const data = await resp.json() as { ok: boolean; files: string[]; label: string; expiresAt: number }
    return data
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:downloadAndSaveUpload', async (_e, token: string, filename: string) => {
  const { workerUrl, uploadSecret } = workerAuth()
  if (!uploadSecret) return { ok: false, error: 'Not configured.' }
  type UReqs = Record<string, { label: string; folderPath: string; url: string; createdAt: string; expiresDays: number }>
  const cfg = readConfig()
  const req = ((cfg.uploadRequests as UReqs) ?? {})[token]
  if (!req) return { ok: false, error: 'Unknown upload request token.' }
  try {
    const resp = await fetch(`${workerUrl}/download-upload/${token}/${encodeURIComponent(filename)}`, {
      headers: { 'Authorization': `Bearer ${uploadSecret}` },
    })
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const buf = Buffer.from(await resp.arrayBuffer())
    const dest = path.join(req.folderPath, filename)
    fs.writeFileSync(dest, buf)
    // Delete from R2 after saving
    fetch(`${workerUrl}/delete-upload/${token}/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${uploadSecret}` },
    }).catch(() => {})
    return { ok: true, path: dest }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('fs:revokeUploadRequest', async (_e, token: string) => {
  const { workerUrl, uploadSecret } = workerAuth()
  if (!uploadSecret) return { ok: false, error: 'Not configured.' }
  try {
    await fetch(`${workerUrl}/upload-request/${token}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${uploadSecret}` },
    })
    type UReqs = Record<string, unknown>
    const cfg = readConfig()
    const requests = { ...((cfg.uploadRequests as UReqs) ?? {}) }
    delete requests[token]
    const merged = { ...cfg, uploadRequests: requests }
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8')
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// For mailto: links, detect which email client is currently running and launch it
// directly rather than going through the Windows default-app registry, which may
// point to the wrong Outlook version.
async function openMailto(mailto: string): Promise<void> {
  const { execSync } = await import('child_process')

  // Known email clients in priority order. Classic Outlook is preferred over
  // "olk.exe" (new Outlook) because the new version often isn't the user's choice.
  const candidates = [
    { exe: 'OUTLOOK.EXE' },   // Outlook Classic
    { exe: 'thunderbird.exe' },
    { exe: 'mailbird.exe' },
    { exe: 'mailspring.exe' },
  ]

  let running: string | null = null
  try {
    const list = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 5000 })
    for (const c of candidates) {
      if (list.toLowerCase().includes(c.exe.toLowerCase())) { running = c.exe; break }
    }
  } catch { /* tasklist failed; fall through to shell.openExternal */ }

  if (running) {
    let exePath = running
    try {
      const wmicOut = execSync(
        `wmic process where "name='${running}'" get ExecutablePath /VALUE`,
        { encoding: 'utf8', timeout: 5000 }
      )
      const match = wmicOut.match(/ExecutablePath=(.+)/i)
      if (match) exePath = match[1].trim()
    } catch { /* wmic failed; use exe name and hope it resolves */ }

    const child = spawn(exePath, [mailto], { detached: true, stdio: 'ignore', shell: false })
    // If the exe isn't found or fails, fall back gracefully — do NOT let this
    // become an uncaught exception that destabilises the main process.
    child.on('error', () => shell.openExternal(mailto))
    child.unref()
    return
  }

  // Fallback: let Windows pick via the registered default
  shell.openExternal(mailto)
}

ipcMain.handle('fs:openExternal', (_e, url: string) => {
  if (url.startsWith('mailto:')) openMailto(url).catch(() => shell.openExternal(url))
  else shell.openExternal(url)
  return true
})

// Annotations: Z:\[Client]\Private\[subfolder__filename].json
function privateDir(pdfPath: string): string {
  const rel = path.relative(currentRootPath, pdfPath)
  const clientName = rel.split(path.sep)[0]
  const dir = path.join(currentRootPath, clientName, 'Private')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function annFile(pdfPath: string): string {
  const rel = path.relative(currentRootPath, pdfPath)
  const parts = rel.split(path.sep)
  const subPath = parts.slice(1).join('__')
  return path.join(privateDir(pdfPath), subPath + '.json')
}

function loadAnnotations(pdfPath: string) {
  try {
    const f = annFile(pdfPath)
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (!data.addedAt) {
        try { data.addedAt = fs.statSync(pdfPath).birthtime.toISOString() } catch {}
        if (data.addedBy === undefined) data.addedBy = null
        try { fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8') } catch {}
      }
      return data
    }
    let addedAt: string | undefined
    try { addedAt = fs.statSync(pdfPath).birthtime.toISOString() } catch {}
    const fresh = { tickmarks: [], signoffs: [], addedAt, addedBy: null }
    try { fs.writeFileSync(f, JSON.stringify(fresh, null, 2), 'utf8') } catch {}
    return fresh
  } catch { return { tickmarks: [], signoffs: [] } }
}

// Sort folders/files: folders first, year folders descending, rest alphabetical
function sortedEntries(entries: fs.Dirent[]) {
  return entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    const aYear = /^\d{4}$/.test(a.name)
    const bYear = /^\d{4}$/.test(b.name)
    if (aYear && bYear) return parseInt(b.name) - parseInt(a.name) // newest first
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hidden',
    title: 'Bellomy Workpapers',
    backgroundColor: '#F4EFE6',
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'))
  }

  mainWin = win
  ipcMain.on('win:minimize', () => win.minimize())
  ipcMain.on('win:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  ipcMain.on('win:close',    () => win.close())
}

ipcMain.handle('fs:getVersion', () => app.getVersion())

ipcMain.handle('fs:checkForUpdates', async () => {
  if (isDev) return { status: 'dev', message: 'Updates disabled in dev mode.' }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) return { status: 'error', message: 'Could not reach update server.' }
    const latest = result.updateInfo.version
    const current = app.getVersion()
    if (latest === current) return { status: 'latest', message: `You're on the latest version (${current}).` }
    return { status: 'available', message: `Update available: v${latest} (you have v${current}). It will install on next restart.`, version: latest }
  } catch (err: unknown) {
    return { status: 'error', message: `Update check failed: ${err instanceof Error ? err.message : String(err)}` }
  }
})

autoUpdater.on('update-downloaded', () => {
  mainWin?.webContents.send('update:downloaded')
})

app.whenReady().then(() => {
  cleanScanInbox() // purge any leftover files from previous session
  createWindow()
  if (!isDev) autoUpdater.checkForUpdatesAndNotify()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── List clients ──────────────────────────────────────────────────────────────
ipcMain.handle('fs:listClients', async (_e, rootPath: string) => {
  currentRootPath = rootPath
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b))
  } catch { return [] }
})

// ── Shallow one-level read: returns folders (empty children) + files ─────────
function shallowRead(dir: string): unknown[] {
  try {
    const entries = sortedEntries(fs.readdirSync(dir, { withFileTypes: true }))
    return entries.map(e => {
      const fullPath = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'Private') return null
        return { name: e.name, type: 'folder', path: fullPath, children: [] }
      }
      if (/\.(pdf|docx?|xlsx?|txt|jpe?g|png|gif|bmp|webp)$/i.test(e.name)) {
        return { name: e.name, type: 'file', path: fullPath, annotations: { tickmarks: [], signoffs: [] } }
      }
      return null
    }).filter(Boolean) as unknown[]
  } catch { return [] }
}

// ── List doc tree (shallow: top-level only, folders have empty children) ─────
ipcMain.handle('fs:listDocs', async (_e, clientPath: string) => {
  return shallowRead(clientPath)
})

// ── Load a single folder's direct children (for lazy expand) ─────────────────
ipcMain.handle('fs:listFolder', async (_e, folderPath: string) => {
  return shallowRead(folderPath)
})

// ── Load annotations for a single file (called on file open) ─────────────────
ipcMain.handle('fs:getAnnotations', async (_e, pdfPath: string) => {
  return loadAnnotations(pdfPath)
})

// ── Combine two PDFs (merge fileAbove + selectedFile → overwrite fileAbove) ───
ipcMain.handle('fs:combineFiles', async (_e, topPath: string, bottomPath: string) => {
  const tmpPath = topPath + '.combining.tmp'
  try {
    const { PDFDocument } = await import('pdf-lib')
    const topBytes    = fs.readFileSync(topPath)
    const bottomBytes = fs.readFileSync(bottomPath)
    const merged = await PDFDocument.create()
    const topDoc    = await PDFDocument.load(topBytes)
    const bottomDoc = await PDFDocument.load(bottomBytes)
    const topPages    = await merged.copyPages(topDoc,    topDoc.getPageIndices())
    const bottomPages = await merged.copyPages(bottomDoc, bottomDoc.getPageIndices())
    topPages.forEach(p => merged.addPage(p))
    bottomPages.forEach(p => merged.addPage(p))
    const mergedBytes = await merged.save()

    // Write to temp file — originals stay untouched until new file is confirmed on disk
    fs.writeFileSync(tmpPath, mergedBytes)
    if (fs.statSync(tmpPath).size < 100) throw new Error('Merged file appears empty')

    // New file confirmed — delete originals then rename temp into place
    fs.unlinkSync(topPath)
    fs.unlinkSync(bottomPath)
    try { const ann = annFile(bottomPath); if (fs.existsSync(ann)) fs.unlinkSync(ann) } catch {}
    fs.renameSync(tmpPath, topPath)

    return { ok: true }
  } catch (e: unknown) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch {}
    return { ok: false, error: String(e) }
  }
})

// ── Read PDF bytes ────────────────────────────────────────────────────────────
ipcMain.handle('fs:readPdf', async (_e, filePath: string) => {
  try {
    const buf = fs.readFileSync(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  } catch { return null }
})

// ── Save annotations ──────────────────────────────────────────────────────────
ipcMain.handle('fs:saveAnnotations', async (_e, pdfPath: string, annotations: unknown) => {
  try {
    fs.writeFileSync(annFile(pdfPath), JSON.stringify(annotations, null, 2), 'utf8')
    return true
  } catch { return false }
})

// ── Move file (drag & drop) ───────────────────────────────────────────────────
// Uses PowerShell Move-Item — fs.rename/copyFile both fail on TaxDome's mapped drive
ipcMain.handle('fs:moveFile', async (_e, srcPath: string, destFolder: string) => {
  const { execFile } = await import('child_process')
  const fileName = path.basename(srcPath)
  const destPath = path.join(destFolder, fileName)

  if (fs.existsSync(destPath)) return { ok: false, error: 'A file with that name already exists in the destination folder.' }

  return new Promise(resolve => {
    const script = `Move-Item -LiteralPath '${srcPath.replace(/'/g,"''")}' -Destination '${destPath.replace(/'/g,"''")}' -Force`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (err, _stdout, stderr) => {
      if (err || stderr.trim()) {
        resolve({ ok: false, error: stderr.trim() || String(err) })
        return
      }
      // Move annotation sidecar if present
      try {
        const srcAnn = annFile(srcPath)
        if (fs.existsSync(srcAnn)) {
          const destAnn = annFile(destPath)
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Move-Item -LiteralPath '${srcAnn.replace(/'/g,"''")}' -Destination '${destAnn.replace(/'/g,"''")}' -Force`
          ], ()=>{})
        }
      } catch { /* annotation move best-effort */ }
      resolve({ ok: true })
    })
  })
})

// ── Rename file ───────────────────────────────────────────────────────────────
ipcMain.handle('fs:renameFile', async (_e, filePath: string, newName: string) => {
  const { execFile } = await import('child_process')
  const dir = path.dirname(filePath)
  const newPath = path.join(dir, newName)
  if (fs.existsSync(newPath)) return { ok: false, error: 'A file with that name already exists.' }
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `Rename-Item -LiteralPath '${filePath.replace(/'/g,"''")}' -NewName '${newName.replace(/'/g,"''")}'`],
      (err, _out, stderr) => {
        if (err || stderr.trim()) { resolve({ ok: false, error: stderr.trim() || String(err) }); return }
        // Rename annotation sidecar (local file, plain rename is fine)
        try {
          const oldAnn = annFile(filePath)
          if (fs.existsSync(oldAnn)) fs.renameSync(oldAnn, annFile(newPath))
        } catch {}
        resolve({ ok: true, newPath })
      }
    )
  })
})

// ── Pick scanner application (.exe) and persist to config ────────────────────
ipcMain.handle('fs:pickScanner', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Programs', extensions: ['exe'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const p = result.filePaths[0]
  const c = readConfig(); c.scannerPath = p
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8')
  return p
})

// ── Scan inbox path (shown in settings so user can configure scanner output) ──
ipcMain.handle('fs:getScanInbox', () => scanInboxPath())

// ── Start scan via NAPS2.Sdk helper ──────────────────────────────────────────
ipcMain.handle('fs:startScan', (_e, destFolder: string, useNativeUI: boolean, dpi?: number, colorMode?: string, scanName?: string, skipBlank?: boolean, appendToPath?: string) => {
  const helperPath = getScanHelperPath()
  if (!fs.existsSync(helperPath))
    return Promise.resolve({ ok: false, error: 'Scanner helper not found. Please reinstall the app.' })

  // Scan to local inbox first so ScanHelper.exe never needs to access the
  // TaxDome virtual drive (or any mapped network drive), which may not be
  // visible to spawned child processes on some machines.
  const localInbox = scanInboxPath()
  const args = ['scan', localInbox]
  if (useNativeUI) args.push('--ui')
  args.push('--dpi', String(dpi ?? 200))
  if (colorMode === 'color') args.push('--color')
  else if (colorMode === 'bw') args.push('--bw')
  // else default grayscale
  if (scanName) args.push('--name', scanName)
  if (skipBlank) args.push('--skip-blank')
  // Once we know which driver actually found the scanner (TWAIN vs WIA), skip
  // re-probing both on every scan — cuts a redundant device enumeration that
  // isn't needed once the right driver is known.
  const cachedDriver = readConfig().scanDriver
  if (typeof cachedDriver === 'string') args.push('--driver', cachedDriver)

  return new Promise<{ ok: boolean; error?: string }>(resolve => {
    const child = spawn(helperPath, args)
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      for (const line of chunk.split('\n')) {
        if (line.startsWith('PAGE:')) {
          const n = parseInt(line.slice(5))
          if (!isNaN(n)) mainWin?.webContents.send('scan:progress', { page: n })
        }
      }
    })

    child.on('close', (code: number | null) => {
      const tryParse = (s: string) => { try { return JSON.parse(s.trim()) } catch { return null } }
      if (code === 0) {
        const result = tryParse(stdout)
        if (result?.ok) {
          if (typeof result.driver === 'string') {
            const c = readConfig(); c.scanDriver = result.driver
            try { fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8') } catch {}
          }
          const src = path.join(localInbox, result.name)
          if (appendToPath) {
            // Merge the newly scanned pages onto the back of an existing PDF instead
            // of saving as a separate file.
            ;(async () => {
              try {
                const { PDFDocument } = await import('pdf-lib')
                const existingBytes = fs.readFileSync(appendToPath)
                const newBytes = fs.readFileSync(src)
                const merged = await PDFDocument.create()
                const existingDoc = await PDFDocument.load(existingBytes)
                const newDoc = await PDFDocument.load(newBytes)
                const existingPages = await merged.copyPages(existingDoc, existingDoc.getPageIndices())
                const newPages = await merged.copyPages(newDoc, newDoc.getPageIndices())
                existingPages.forEach(p => merged.addPage(p))
                newPages.forEach(p => merged.addPage(p))
                const mergedBytes = await merged.save()
                fs.writeFileSync(appendToPath, mergedBytes)
                try { fs.unlinkSync(src) } catch {}
                mainWin?.webContents.send('scan:fileArrived', { name: path.basename(appendToPath), destFolder: path.dirname(appendToPath), appended: true })
                resolve({ ok: true })
              } catch (mergeErr: unknown) {
                resolve({ ok: false, error: `Scan succeeded but could not append to "${path.basename(appendToPath)}": ${String(mergeErr)}` })
              }
            })()
            return
          }
          // Copy from local inbox to the actual destination (runs in the main
          // process which has full access to the TaxDome virtual drive).
          try {
            if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true })
            const dest = path.join(destFolder, result.name)
            fs.copyFileSync(src, dest)
            try { fs.unlinkSync(src) } catch {}
            mainWin?.webContents.send('scan:fileArrived', { name: result.name, destFolder })
            resolve({ ok: true })
          } catch (copyErr: unknown) {
            const dest = path.join(destFolder, result.name)
            resolve({ ok: false, error: `Scan succeeded but could not save to destination: ${diagnoseWriteFailure(destFolder, dest, copyErr)}` })
          }
        } else {
          if (cachedDriver && /no scanner devices found|device not found/i.test(result?.error ?? '')) {
            const c = readConfig(); delete c.scanDriver
            try { fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8') } catch {}
          }
          resolve({ ok: false, error: result?.error ?? 'Scan failed' })
        }
      } else {
        const errLines = stderr.trim().split('\n').filter((l: string) => l.startsWith('{'))
        const result = errLines.length ? tryParse(errLines[errLines.length - 1]) : null
        if (cachedDriver && /no scanner devices found|device not found/i.test(result?.error ?? '')) {
          const c = readConfig(); delete c.scanDriver
          try { fs.writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8') } catch {}
        }
        resolve({ ok: false, error: result?.error ?? `Scanner exited with code ${code}` })
      }
    })

    child.on('error', (err: Error) => resolve({ ok: false, error: err.message }))
  })
})

// ── List TWAIN devices ────────────────────────────────────────────────────────
ipcMain.handle('fs:listScanDevices', () => {
  const helperPath = getScanHelperPath()
  if (!fs.existsSync(helperPath))
    return Promise.resolve({ ok: false, devices: [], error: 'Scanner helper not found.' })

  return new Promise<{ ok: boolean; devices: { ID: string; Name: string }[]; error?: string }>(resolve => {
    const child = spawn(helperPath, ['list'])
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.on('close', () => {
      try { resolve(JSON.parse(stdout.trim())) }
      catch { resolve({ ok: false, devices: [], error: 'Failed to list devices' }) }
    })
    child.on('error', (err: Error) => resolve({ ok: false, devices: [], error: err.message }))
  })
})

ipcMain.handle('fs:stopScanWatcher', () => stopScanWatcher())

// ── Folder picker ─────────────────────────────────────────────────────────────
ipcMain.handle('fs:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

// ── Delete file ───────────────────────────────────────────────────────────────
ipcMain.handle('fs:deleteFile', async (_e, filePath: string) => {
  const { execFile } = await import('child_process')
  return new Promise(resolve => {
    const script = `Remove-Item -LiteralPath '${filePath.replace(/'/g,"''")}' -Force`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (err, _out, stderr) => {
      if (err || stderr.trim()) { resolve({ ok: false, error: stderr.trim() || String(err) }); return }
      try { const ann = annFile(filePath); if (fs.existsSync(ann)) fs.unlinkSync(ann) } catch {}
      resolve({ ok: true })
    })
  })
})

// ── Copy file (creates "(Copy N)" sibling) ────────────────────────────────────
ipcMain.handle('fs:copyFile', async (_e, srcPath: string) => {
  const { execFile } = await import('child_process')
  const dir  = path.dirname(srcPath)
  const ext  = path.extname(srcPath)
  const base = path.basename(srcPath, ext)
  let n = 2
  let destPath = path.join(dir, `${base} (Copy ${n})${ext}`)
  while (fs.existsSync(destPath)) { n++; destPath = path.join(dir, `${base} (Copy ${n})${ext}`) }
  return new Promise(resolve => {
    const script = `Copy-Item -LiteralPath '${srcPath.replace(/'/g,"''")}' -Destination '${destPath.replace(/'/g,"''")}' -Force`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (err, _out, stderr) => {
      if (err || stderr.trim()) { resolve({ ok: false, error: stderr.trim() || String(err) }); return }
      resolve({ ok: true, destPath })
    })
  })
})

// ── Save PDF bytes back to disk ───────────────────────────────────────────────
ipcMain.handle('fs:savePdf', async (_e, filePath: string, bytes: ArrayBuffer) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(bytes))
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})

// ── Print file (full doc) ─────────────────────────────────────────────────────
ipcMain.handle('fs:printFile', async (_e, filePath: string) => {
  const { execFile } = await import('child_process')
  return new Promise(resolve => {
    const script = `Start-Process -FilePath '${filePath.replace(/'/g,"''")}' -Verb Print`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (err, _out, stderr) => {
      if (err || stderr.trim()) resolve({ ok: false, error: stderr.trim() || String(err) })
      else resolve({ ok: true })
    })
  })
})

// ── Print bytes (single page) — write temp file and print ─────────────────────
ipcMain.handle('fs:printBytes', async (_e, bytes: ArrayBuffer) => {
  const { execFile } = await import('child_process')
  const tmpPath = path.join(app.getPath('temp'), `bellomy-print-${Date.now()}.pdf`)
  try {
    fs.writeFileSync(tmpPath, Buffer.from(bytes))
    return new Promise<{ok:boolean;error?:string}>(resolve => {
      const script = `Start-Process -FilePath '${tmpPath.replace(/'/g,"''")}' -Verb Print`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (err, _out, stderr) => {
        if (err || stderr.trim()) resolve({ ok: false, error: stderr.trim() || String(err) })
        else resolve({ ok: true })
      })
    })
  } catch (e: unknown) { return { ok: false, error: String(e) } }
})

// ── Rename folder ─────────────────────────────────────────────────────────────
ipcMain.handle('fs:renameFolder', async (_e, folderPath: string, newName: string) => {
  const { execFile } = await import('child_process')
  const parent  = path.dirname(folderPath)
  const newPath = path.join(parent, newName)
  if (fs.existsSync(newPath)) return { ok: false, error: 'A folder with that name already exists.' }
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `Rename-Item -LiteralPath '${folderPath.replace(/'/g,"''")}' -NewName '${newName.replace(/'/g,"''")}'`],
      (err, _out, stderr) => {
        if (err || stderr.trim()) { resolve({ ok: false, error: stderr.trim() || String(err) }); return }
        resolve({ ok: true, newPath })
      }
    )
  })
})

// ── Open a file in its default native application ────────────────────────────
ipcMain.handle('fs:openFile', async (_e, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found.' }
    const result = await shell.openPath(filePath)
    if (result) return { ok: false, error: result || 'No application is associated with this file type.' }
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})

// ── Create a subfolder ────────────────────────────────────────────────────────
ipcMain.handle('fs:createFolder', async (_e, parentPath: string, name: string) => {
  try {
    const clean = name.trim()
    if (!clean) return { ok: false, error: 'Folder name cannot be empty.' }
    const dest = path.join(parentPath, clean)
    if (fs.existsSync(dest)) return { ok: false, error: 'A folder with that name already exists.' }
    fs.mkdirSync(dest, { recursive: true })
    return { ok: true, path: dest }
  } catch (err: unknown) { return { ok: false, error: String(err) } }
})

// ── Create a Notes text file in a folder (named "<year> Notes.txt" or "Notes.txt") ──
ipcMain.handle('fs:createNotesFile', async (_e, folderPath: string) => {
  try {
    const folderName = path.basename(folderPath)
    const yearMatch = folderName.match(/\d{4}/)
    const baseName = yearMatch ? `${yearMatch[0]} Notes` : 'Notes'
    let dest = path.join(folderPath, `${baseName}.txt`)
    let n = 2
    while (fs.existsSync(dest)) { dest = path.join(folderPath, `${baseName} (${n}).txt`); n++ }
    fs.writeFileSync(dest, '', 'utf8')
    const result = await shell.openPath(dest)
    if (result) return { ok: true, path: dest, openError: result }
    return { ok: true, path: dest }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})

// ── Read / write a plain text file (Notes) ────────────────────────────────────
ipcMain.handle('fs:readTextFile', async (_e, filePath: string) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf8') } }
  catch (e: unknown) { return { ok: false, error: String(e) } }
})

ipcMain.handle('fs:writeTextFile', async (_e, filePath: string, content: string) => {
  try { fs.writeFileSync(filePath, content, 'utf8'); return { ok: true } }
  catch (e: unknown) { return { ok: false, error: String(e) } }
})

// ── Find a client's 1040/1120/1065/990 (most recent year) ────────────────────
function findTaxFormSync(clientPath: string): { path: string; name: string; year: string | null } | null {
  const formRe     = /(1040|1120s?|1065|990)/i
  const excludeRe  = /(1040-?(es|v|x|sr)|1120-?(w|x)|990-?(es|w|t|x|pf)|1065-?x|8879|8453|authorization|engagement|e-?file)/i
  const taxRetRe   = /tax\s*return/i
  const amendedRe  = /amend/i
  const federalRe  = /\b(us|u\.s\.|federal|fed)\b/i
  const reviewRe   = /review|draft|proforma/i
  const results: { path: string; name: string; year: string | null; score: number }[] = []

  function walk(dir: string, depth: number, year: string | null) {
    if (depth > 5) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'Private') continue
        const yr = /^\d{4}$/.test(e.name) ? e.name : year
        walk(full, depth + 1, yr)
      } else if (/\.pdf$/i.test(e.name)) {
        if (amendedRe.test(e.name)) continue
        let score = 0
        if (formRe.test(e.name) && !excludeRe.test(e.name)) score += 100
        else if (taxRetRe.test(e.name)) score += 10
        else continue
        if (federalRe.test(e.name)) score += 50
        if (reviewRe.test(e.name)) score -= 200
        results.push({ path: full, name: e.name, year, score })
      }
    }
  }
  walk(clientPath, 0, null)
  if (results.length === 0) return null
  results.sort((a, b) => (b.year ?? '0').localeCompare(a.year ?? '0') || b.score - a.score)
  return results[0]
}

function findTaxFormsSync(clientPath: string): { path: string; name: string; year: string | null }[] {
  const formRe     = /(1040|1120s?|1065|990)/i
  const excludeRe  = /(1040-?(es|v|x|sr)|1120-?(w|x)|990-?(es|w|t|x|pf)|1065-?x|8879|8453|authorization|engagement|e-?file)/i
  const taxRetRe   = /tax\s*return/i
  const amendedRe  = /amend/i
  const federalRe  = /\b(us|u\.s\.|federal|fed)\b/i
  const reviewRe   = /review|draft|proforma/i
  const results: { path: string; name: string; year: string | null; score: number }[] = []

  function walk(dir: string, depth: number, year: string | null) {
    if (depth > 5) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'Private') continue
        const yr = /^\d{4}$/.test(e.name) ? e.name : year
        walk(full, depth + 1, yr)
      } else if (/\.pdf$/i.test(e.name)) {
        if (amendedRe.test(e.name)) continue
        let score = 0
        if (formRe.test(e.name) && !excludeRe.test(e.name)) score += 100
        else if (taxRetRe.test(e.name)) score += 10
        else continue
        if (federalRe.test(e.name)) score += 50
        if (reviewRe.test(e.name)) score -= 200
        results.push({ path: full, name: e.name, year, score })
      }
    }
  }
  walk(clientPath, 0, null)
  results.sort((a, b) => (b.year ?? '0').localeCompare(a.year ?? '0') || b.score - a.score)
  return results
}

ipcMain.handle('fs:findTaxForm', async (_e, clientPath: string) => {
  try {
    return { ok: true, result: findTaxFormSync(clientPath) }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:findTaxForms', async (_e, clientPath: string) => {
  try {
    return { ok: true, results: findTaxFormsSync(clientPath) }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})

// ── Hoist folder: copy a folder's full contents to a temp "cabinet" ──────────
ipcMain.handle('fs:hoistFolder', async (_e, folderPath: string) => {
  try {
    const id = crypto.randomUUID()
    const dest = path.join(app.getPath('temp'), 'bellomy-hoist', id, path.basename(folderPath))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(folderPath, dest, { recursive: true })
    return { ok: true, path: dest }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})

// ── Unhoist: copy back any newly created files, then delete the temp cabinet ─
ipcMain.handle('fs:unhoistFolder', async (_e, hoistPath: string, originalFolder: string) => {
  try {
    // Only ever delete inside our own temp hoist directory
    const hoistRoot = path.join(app.getPath('temp'), 'bellomy-hoist')
    const resolved = path.resolve(hoistPath)
    if (!resolved.startsWith(path.resolve(hoistRoot) + path.sep)) {
      return { ok: false, error: 'Refusing to delete outside the hoist temp directory.' }
    }

    // Copy back any files/folders that were newly created in the hoisted
    // copy and don't exist in the original folder
    function copyNewEntries(srcDir: string, destDir: string) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(srcDir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const srcFull = path.join(srcDir, e.name)
        const destFull = path.join(destDir, e.name)
        if (e.isDirectory()) {
          if (fs.existsSync(destFull)) {
            copyNewEntries(srcFull, destFull)
          } else {
            fs.cpSync(srcFull, destFull, { recursive: true })
          }
        } else if (!fs.existsSync(destFull)) {
          fs.mkdirSync(destDir, { recursive: true })
          fs.cpSync(srcFull, destFull)
        }
      }
    }
    if (originalFolder) copyNewEntries(resolved, originalFolder)

    // Remove the per-hoist parent directory (one level up from the copied folder)
    const hoistDir = path.dirname(resolved)
    fs.rmSync(hoistDir, { recursive: true, force: true })
    return { ok: true }
  } catch (e: unknown) {
    return { ok: false, error: String(e) }
  }
})
