# Bellomy Workpapers — Developer Handover Guide

**Current version:** 1.0.62  
**GitHub:** https://github.com/bsbellomy/bellomy-workpapers  
**Last updated:** 2026-08-20

---

## What this app is

Bellomy Workpapers is an internal Electron desktop app for Bellomy Accounting (a CPA firm). It runs on Windows machines in the office and provides:

- PDF viewer for tax documents stored on a TaxDome-mapped network drive (Z: or T:)
- Annotation tools: tickmarks, tape stamps, highlights, cross-references, sign-off tracking
- Bookmark/outline generation for PDFs
- Scanner integration (TWAIN/WIA via NAPS2)
- Magic link sharing (single-view, expiring file links sent to clients via email)
- Client upload portal (clients upload documents; firm receives them in the app)
- Auto-update via GitHub releases

The app is **Windows-only**. The scanner component (ScanHelper) targets Windows TWAIN/WIA APIs.

---

## Repository layout

```
bellomy-workpapers/
├── src/
│   ├── main/main.ts          # Electron main process — all IPC handlers, file I/O, scan, email
│   ├── renderer/src/App.tsx  # React renderer — all UI (single large component)
│   └── preload/preload.ts    # contextBridge — exposes main→renderer API
├── scanner/
│   └── ScanHelper/           # C# .NET 8 console app (NAPS2 scan wrapper)
│       ├── Program.cs
│       └── ScanHelper.csproj
├── cloudflare-worker/
│   ├── worker.js             # Cloudflare Worker (magic links + client upload portal)
│   └── wrangler.toml         # Cloudflare deployment config
├── assets/
│   └── icon.ico              # App icon
├── package.json
└── HANDOVER.md               # This file
```

---

## Development environment requirements

### Node.js
- **Version: v24** (tested on v24.16.0)
- Install from https://nodejs.org
- After installing, you may need to add a Node v24 compatibility fix to the electron package (see Known Quirks below)

### .NET SDK 8
- Required to build the ScanHelper scanner
- Install from https://dotnet.microsoft.com/download/dotnet/8.0
- Target: `net8.0-windows`, `win-x64`, self-contained

### Git
- Identity should be set: `git config --global user.name "Billy Bellomy"` / `git config --global user.email "billybellomy29@gmail.com"`

### GitHub Personal Access Token (GH_TOKEN)
- Required to publish releases to GitHub
- Create at github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)
- Needs `repo` scope only
- Store permanently: `[System.Environment]::SetEnvironmentVariable("GH_TOKEN", "ghp_...", "User")`
- `npm run release` reads it automatically from the environment

---

## First-time setup on a new machine

```powershell
git clone https://github.com/bsbellomy/bellomy-workpapers
cd bellomy-workpapers
npm install
```

### Node v24 electron fix (if the app won't start in dev mode)
If you see an error about electron not being found or an ESM/CJS mismatch:

1. Check `node_modules\electron\path.txt` — it must contain exactly `electron.exe` (no path, no newline junk)
2. Open `node_modules\electron\package.json` and ensure it has `"type": "commonjs"` — add it if missing

### To run in development mode
```powershell
npm run dev
```
This starts the Vite renderer dev server on port 5173 and the Electron main process. HMR is active — renderer changes update instantly without restarting.

---

## Build and release

```powershell
# Build only (no installer)
npm run build

# Build installer locally (no publish)
npm run package

# Build + publish to GitHub releases (requires GH_TOKEN)
$env:GH_TOKEN = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
npm run release
```

### Build steps (what `npm run build` does)
1. `build:scanner` — `dotnet publish` the ScanHelper C# project → `scanner/ScanHelper/bin/publish/`
2. `build:renderer` — Vite bundles the React app → `dist/renderer/`
3. `build:main` — `tsc` compiles main.ts → `dist/main/`

### electron-builder packaging notes
- **CRITICAL:** Always delete `dist/win-unpacked` before running `npm run release` if it exists from a previous build.  
  The `files` pattern in package.json explicitly uses `dist/main/**/*` and `dist/renderer/**/*` (NOT `dist/**/*`) to avoid the win-unpacked directory getting packaged inside the new asar, which would make each build 2x the size of the last and eventually cause NSIS to fail with a "failed creating mmap" error.
- Installer is ~127 MB (Electron ~90 MB + pdf.js + pdf-lib + scanner binary)
- Published to GitHub Releases as `Bellomy-Workpapers-Setup-{version}.exe`
- Auto-update: users get a prompt when a new release is published; electron-updater handles download and install

---

## App configuration (not in git)

User-specific config lives in `%APPDATA%\bellomy-workpapers\bellomy-config.json`. This file is **not in the repo** and must be set up via the app's Settings UI on each machine. Key values:

| Key | Description |
|-----|-------------|
| `userName` | The logged-in staff member's display name (used for tickmarks, sign-offs, notes filenames) |
| `workerUrl` | Cloudflare Worker URL — default `https://share.bellomycpa.com` |
| `uploadSecret` | Shared secret for authenticating uploads to the Cloudflare Worker |
| `rootPath` | Path to the client document root (usually `Z:\` or `T:\`) |
| `bookmarkButtons` | Array of custom bookmark button definitions per machine |
| `scannerDevice` | Selected scanner device ID |

Encrypted secrets (via Electron safeStorage) are stored separately but also in `%APPDATA%\bellomy-workpapers\`.

**To migrate config to a new machine:** copy `%APPDATA%\bellomy-workpapers\` from the old machine, or re-enter all values through the app Settings after first launch.

---

## Cloudflare Worker (magic links + upload portal)

The worker lives in `cloudflare-worker/` and is deployed separately from the Electron app. It runs at `share.bellomycpa.com`.

### What it does
- **Magic links:** app uploads a PDF to the worker → worker stores in R2 + creates KV record → worker emails a single-view expiring link to the client → first click streams the file and deletes it from R2
- **Upload requests:** firm creates a request → sends link to client → client uploads files via browser → firm sees badge in app and can save files to their TaxDome folder

### Infrastructure (Cloudflare account)
- **R2 bucket:** `bellomy-magic-links`
- **KV namespace:** `LINKS_KV` (id: `8184c23c34c940048874202c63be1a59`)
- **Custom domain:** `share.bellomycpa.com` (on Cloudflare DNS)
- **Secret:** `UPLOAD_SECRET` — set via `wrangler secret put UPLOAD_SECRET` (not stored in repo)

### Where the upload secret lives
The `UPLOAD_SECRET` must match in three places:
1. **Cloudflare Worker** — set via `wrangler secret put UPLOAD_SECRET` (write-only, not readable back from dashboard)
2. **Each office machine** — entered in Bellomy Workpapers → Settings → Magic Links → Upload Secret field. Stored encrypted via Electron safeStorage in `%APPDATA%\bellomy-workpapers\`. The UI masks it with dots and cannot display it back.
3. **Server `.env`** — stored in `D:\Projects\bellomy-workpapers\.env` as `UPLOAD_SECRET=value` for use by any tooling/scripts that need it. This file is gitignored.

If the secret is ever lost: generate a new one, run `wrangler secret put UPLOAD_SECRET` in `cloudflare-worker/`, and re-enter it in the app Settings on every office machine.

### To redeploy the worker after changes
```bash
cd cloudflare-worker
npx wrangler deploy
```

### To set up from scratch on a new Cloudflare account
See `cloudflare-worker/README.md` — it has the full step-by-step setup.

---

## Scanner (ScanHelper)

`scanner/ScanHelper/` is a standalone C# .NET 8 console app that wraps NAPS2's scanning SDK. The Electron main process spawns it as a child process and communicates via stdin/stdout JSON.

**Commands:**
- `ScanHelper list` — lists available TWAIN/WIA scanner devices (tries both drivers)
- `ScanHelper scan <dest-folder> [--device <id>] [--ui] [--driver twain|wia] [--dpi N] [--color|--grayscale|--bw] [--name <filename>] [--skip-blank]`

**Output:** JSON on stdout `{ ok, path, name, pages, driver }` or `{ ok: false, error }`. Progress signals `PAGE:N` on stderr.

The built binary goes to `scanner/ScanHelper/bin/publish/` and is bundled into the app installer as an `extraResource` at `resources/scanner/`.

**Scanner + TaxDome drive:** TaxDome maps a network drive (Z: or T:) using a desktop sync app. If that drive isn't mapped when Workpapers launches, scans fail. The app auto-launches TaxDome on startup with a 4-second wait for the drive to mount. It prefers the newer install `C:\Program Files\TaxDomeApp\TaxDome.exe` and falls back to the older `C:\Program Files (x86)\TaxDome\TaxDome.exe` (see `TAXDOME_EXES` in `main.ts`); both run as `TaxDome.exe`.

---

## TaxDome integration notes

- TaxDome desktop app must be installed and logged in on each machine
- It maps a network share as Z: (or T: — configurable in Workpapers settings)
- New client folders can take a few minutes to fully provision write access after being created in TaxDome — scans to a brand-new client folder may fail with EPERM briefly; wait and retry
- Windows "Controlled Folder Access" (ransomware protection) can block writes to network drives — add Bellomy Workpapers as an allowed app if CFA is enabled

---

## Email integration

The app composes emails by launching Classic Outlook directly (not the Windows `mailto:` protocol handler) to avoid accidentally opening New Outlook on machines that have both installed.

Detection logic in `main.ts → openMailto()`:
1. Checks `tasklist` for `OUTLOOK.EXE`
2. Uses `wmic` to get all Outlook executable paths
3. Prefers paths containing `\Microsoft Office\` or `\Office1x\` over `\WindowsApps\` (New Outlook)
4. Invokes Classic Outlook with `/c IPM.Note /m <mailto-string>` to bypass the Windows protocol handler

If a user reports New Outlook opening instead of Classic, check:
- That Classic Outlook is the default email client (Control Panel → Mail)
- That the default data file in Control Panel → Mail → Data Files is set to the correct profile

---

## Known quirks and past incidents

### electron path.txt / Node v24 CJS issue
After `npm install` on a fresh Node v24 machine, Electron may fail to start because its package.json lacks `"type": "commonjs"`. Add it manually. The `path.txt` inside the electron package must also contain just `electron.exe`.

### dist/win-unpacked bloat
The electron-builder `files` array in `package.json` must list `dist/main/**/*` and `dist/renderer/**/*` explicitly — NOT `dist/**/*`. The broader pattern causes `win-unpacked` (the unpacked Electron app from the previous build) to get included in the new build's asar, doubling the size each release until the NAPS2 packager fails. This was fixed in v1.0.55 (commit `80b7130`).

### Edit Folder modal combine data loss (fixed v1.0.55)
The "combine files" feature in the Edit Folder modal was deleting the merged output file immediately after writing it. The delete loop deleted all selected files including the output file itself. Fixed by writing to a `.merging.tmp` file, verifying page count matches, deleting originals, then renaming tmp into place.

### Classic Outlook vs New Outlook (fixed v1.0.51)
Machines with both Classic and New Outlook installed would open New Outlook. Fixed by detecting and preferring the Classic Outlook executable path, then using `/c IPM.Note /m` to bypass the Windows `mailto:` protocol handler.

### Upload 404 on "Save to Folder" (fixed v1.0.53)
Filenames with spaces were stored in R2 as `my file.pdf` but looked up as `my%20file.pdf` because the Cloudflare Worker parsed the URL path without `decodeURIComponent`. Fixed in `cloudflare-worker/worker.js`.

### Scanner crash reporting (fixed v1.0.54)
Unhandled .NET exceptions on background threads (exit code `3762504530` / `0xE0434352`) were previously reported only as a numeric exit code. Fixed by adding `AppDomain.CurrentDomain.UnhandledException` handler in `Program.cs` and including raw stderr in the Electron error message.

### Scanner EPERM on new TaxDome folders
New TaxDome client folders can appear writable in Explorer but reject writes for a few minutes after creation while TaxDome provisions them. Also, Windows Controlled Folder Access can block network drive writes. If a scan fails with EPERM, wait 2–3 minutes and retry; if it persists, check CFA settings.

---

## Version history summary

| Version | Key changes |
|---------|-------------|
| 1.0.56 | Notes filename includes author name + date; file panel items draggable to OS targets (email, browser, etc.) |
| 1.0.55 | Fixed Edit Folder modal combine deleting merged output; fixed dist/win-unpacked packaging bloat |
| 1.0.54 | Better scanner crash reporting (includes .NET exception text) |
| 1.0.53 | Fixed upload "Save to Folder" 404 (URL decoding); grouped upload inbox by client; visible toast for new uploads |
| 1.0.51 | Fixed Classic vs New Outlook detection; `/c IPM.Note /m` to bypass protocol handler |
| 1.0.50 | Preferred Classic Outlook path when both installed |
| 1.0.48 | Toolbar combine: temp-file safety + page count verification before deleting originals |
| 1.0.47 | TaxDome auto-launch on startup; 4-second wait for drive mount |
| 1.0.45 | Bookmark buttons load at App level (not inside modal) to fix IPC timing race |
| 1.0.44 | Bookmark rework: every button click = top-level bookmark; + key = advance without tagging; unassigned pages = children of preceding top-level; sort by button panel order |

---

## Contacts

- **Owner/developer:** Billy Bellomy — billybellomy29@gmail.com
- **GitHub repo:** https://github.com/bsbellomy/bellomy-workpapers (private)
- **Cloudflare account:** tied to billy@bellomycpa.com
