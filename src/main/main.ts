import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let currentRootPath = 'Z:\\'

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
    if (!fs.existsSync(f)) return { tickmarks: [], signoffs: [] }
    return JSON.parse(fs.readFileSync(f, 'utf8'))
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

  ipcMain.on('win:minimize', () => win.minimize())
  ipcMain.on('win:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize())
  ipcMain.on('win:close',    () => win.close())
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── List clients ──────────────────────────────────────────────────────────────
ipcMain.handle('fs:listClients', async (_e, rootPath: string) => {
  currentRootPath = rootPath
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b))
  } catch { return [] }
})

// ── List doc tree (no annotation reads — load those separately on file open) ──
ipcMain.handle('fs:listDocs', async (_e, clientPath: string) => {
  function readDir(dir: string): unknown[] {
    try {
      const entries = sortedEntries(fs.readdirSync(dir, { withFileTypes: true }))
      return entries.map(e => {
        const fullPath = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === 'Private') return null
          return { name: e.name, type: 'folder', path: fullPath, children: readDir(fullPath) }
        }
        if (/\.(pdf)$/i.test(e.name)) {
          return { name: e.name, type: 'file', path: fullPath, annotations: { tickmarks: [], signoffs: [] } }
        }
        return null
      }).filter(Boolean) as unknown[]
    } catch { return [] }
  }
  return readDir(clientPath)
})

// ── Load annotations for a single file (called on file open) ─────────────────
ipcMain.handle('fs:getAnnotations', async (_e, pdfPath: string) => {
  return loadAnnotations(pdfPath)
})

// ── Combine two PDFs (merge fileAbove + selectedFile → overwrite fileAbove) ───
ipcMain.handle('fs:combineFiles', async (_e, topPath: string, bottomPath: string) => {
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
    fs.writeFileSync(topPath, mergedBytes)
    // Remove the bottom file and its annotation
    fs.unlinkSync(bottomPath)
    try { const ann = annFile(bottomPath); if (fs.existsSync(ann)) fs.unlinkSync(ann) } catch {}
    return { ok: true }
  } catch (e: unknown) {
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

// ── Launch system scanner ─────────────────────────────────────────────────────
ipcMain.handle('fs:scan', async () => {
  try {
    // Windows Fax and Scan — available on all Windows 10/11 machines
    shell.openPath('C:\\Windows\\System32\\WFS.exe').then(err => {
      if (err) {
        // Fallback: open Windows Scan from the Store URI
        shell.openExternal('ms-windows-store://pdp/?PFN=Microsoft.WindowsScan_8wekyb3d8bbwe')
      }
    })
    return true
  } catch { return false }
})

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
