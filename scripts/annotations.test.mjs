// Offline test for annotation sidecar writes.
//
//   node scripts/annotations.test.mjs
//
// Runs against the BUILT main process (dist/main/main/annotations.js), so run
// `npm run build:main` first. Also runs as a gate inside `npm run smoke`.
//
// This exists because of a live failure found on 2026-10-05:
//
//   loadAnnotations() wrote a 99-byte {tickmarks:[],signoffs:[]} placeholder the
//   first time anyone opened a document. The workpapers root is the TaxDome
//   drive (T:), so each placeholder synced up as a real TaxDome document in the
//   client's Private folder -- 28 of them for MAGO6841, one per intake file,
//   created just by reading the client's documents in order. Nothing errored and
//   nothing showed it in the app, which hides Private from its own tree. The
//   names ("Client uploaded documents__2025__<file>.pdf.json") read like
//   pipeline metadata dumped into the client's own folder, which is how it was
//   eventually noticed.
//
// The invariant: nothing is written to Private unless a document actually
// carries annotations. Reading is side-effect-free.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const builtPath = join(here, '..', 'dist', 'main', 'main', 'annotations.js')

if (!existsSync(builtPath)) {
  console.error(`FAIL: ${builtPath} not found -- run \`npm run build:main\` first.`)
  process.exit(1)
}

const mod = await import('file://' + builtPath.replace(/\\/g, '/'))
const { annFile, privateDir, isEmptyAnnotations, loadAnnotations, saveAnnotations } = mod.default ?? mod

let failures = []
function check(name, cond, detail = '') {
  if (cond) return
  failures.push(detail ? `${name}: ${detail}` : name)
}

// ── Fixture: a root with one client and one document ─────────────────────────
const root = mkdtempSync(join(tmpdir(), 'wp-ann-'))
const client = join(root, 'Magoon, Steve & Ann')
const yearDir = join(client, 'Client uploaded documents', '2025')
mkdirSync(yearDir, { recursive: true })
const pdf = join(yearDir, '01 - SSA-1099 - Steve.pdf')
writeFileSync(pdf, '%PDF-1.4 fixture')
const priv = join(client, 'Private')

const privFiles = () => (existsSync(priv) ? readdirSync(priv) : [])

// ── 1. Path shape ────────────────────────────────────────────────────────────
check(
  'sidecar path flattens the client-relative path with __',
  annFile(root, pdf) === join(priv, 'Client uploaded documents__2025__01 - SSA-1099 - Steve.pdf.json'),
  annFile(root, pdf),
)

// ── 2. Computing a path creates nothing ──────────────────────────────────────
annFile(root, pdf)
privateDir(root, pdf)
check('computing a sidecar path does not create Private', !existsSync(priv))

// ── 3. THE REGRESSION: opening a document creates no sidecar ─────────────────
const fresh = loadAnnotations(root, pdf)
check('load returns empty tickmarks', Array.isArray(fresh.tickmarks) && fresh.tickmarks.length === 0)
check('load returns empty signoffs', Array.isArray(fresh.signoffs) && fresh.signoffs.length === 0)
check('load back-fills addedAt from the file', typeof fresh.addedAt === 'string')
check(
  'loading annotations writes NOTHING to Private',
  privFiles().length === 0,
  `Private contains ${JSON.stringify(privFiles())}`,
)

// Repeated opens stay side-effect-free.
for (let i = 0; i < 5; i++) loadAnnotations(root, pdf)
check('repeated opens still write nothing', privFiles().length === 0, `Private contains ${JSON.stringify(privFiles())}`)

// ── 4. Empty payloads are not persisted ──────────────────────────────────────
for (const [label, payload] of [
  ['bare empty', { tickmarks: [], signoffs: [] }],
  ['all arrays empty', { tickmarks: [], signoffs: [], tapeStamps: [], highlights: [], textNotes: [] }],
  ['addedAt only', { tickmarks: [], signoffs: [], addedAt: new Date().toISOString(), addedBy: null }],
  ['addedBy blank', { tickmarks: [], signoffs: [], addedBy: '' }],
]) {
  check(`isEmptyAnnotations: ${label}`, isEmptyAnnotations(payload) === true)
  check(`save does not persist: ${label}`, saveAnnotations(root, pdf, payload) === true)
  check(`nothing written for: ${label}`, privFiles().length === 0, `Private contains ${JSON.stringify(privFiles())}`)
}

// ── 5. Real content IS persisted ─────────────────────────────────────────────
const withTick = {
  tickmarks: [{ id: 't1', page: 1, x: 10, y: 20, type: 'check', note: '', author: 'Billy Bellomy', createdAt: new Date().toISOString() }],
  signoffs: [],
}
check('isEmptyAnnotations: with a tickmark', isEmptyAnnotations(withTick) === false)
check('save with a tickmark succeeds', saveAnnotations(root, pdf, withTick) === true)
check('sidecar written for real content', existsSync(annFile(root, pdf)))
check(
  'sidecar round-trips',
  JSON.parse(readFileSync(annFile(root, pdf), 'utf8')).tickmarks?.[0]?.id === 't1',
)
check('load reads the sidecar back', loadAnnotations(root, pdf).tickmarks.length === 1)

// addedBy alone counts -- it is the only record of who scanned a file in.
check('isEmptyAnnotations: addedBy set', isEmptyAnnotations({ tickmarks: [], signoffs: [], addedBy: 'Billy Bellomy' }) === false)

// ── 6. Clearing the last annotation removes the sidecar ──────────────────────
check('save empty over existing succeeds', saveAnnotations(root, pdf, { tickmarks: [], signoffs: [] }) === true)
check(
  'clearing annotations deletes the sidecar',
  !existsSync(annFile(root, pdf)) && privFiles().length === 0,
  `Private contains ${JSON.stringify(privFiles())}`,
)

// ── 7. Overwriting with a shorter payload leaves no tail ─────────────────────
// The Dokan mount behind T: does not reliably honour mode "w"'s truncate, so a
// shorter rewrite used to leave the previous version's tail behind and produce
// invalid JSON. saveAnnotations must truncate to exactly what it wrote.
//
// Caveat: this runs on a local temp filesystem, which truncates correctly on its
// own, so these assertions cannot reproduce the Dokan behaviour -- they only
// confirm the write path is sane. The real protection against sidecars already
// corrupted on T: is section 8, which does fail without the recovery parser.
const long = {
  tickmarks: Array.from({ length: 6 }, (_, i) => ({
    id: `long-${i}`, page: i + 1, x: 1, y: 2, type: 'check', note: 'a long note to pad the file out', author: 'Lisa Crain', createdAt: new Date().toISOString(),
  })),
  signoffs: [],
}
saveAnnotations(root, pdf, long)
const longBytes = readFileSync(annFile(root, pdf), 'utf8').length
const short = { tickmarks: [long.tickmarks[0]], signoffs: [] }
saveAnnotations(root, pdf, short)
const afterShort = readFileSync(annFile(root, pdf), 'utf8')
check('shorter rewrite actually shrinks the file', afterShort.length < longBytes, `${afterShort.length} vs ${longBytes}`)
check(
  'shorter rewrite leaves no stale tail (valid JSON)',
  (() => { try { JSON.parse(afterShort); return true } catch { return false } })(),
  JSON.stringify(afterShort.slice(-40)),
)
check('shorter rewrite round-trips', loadAnnotations(root, pdf).tickmarks.length === 1)

// ── 8. A sidecar already corrupted on disk still reads back ──────────────────
// Sidecars written before the truncate fix carry trailing garbage. Those
// annotations must come back rather than reading as "no annotations", which is
// how real highlights went invisible in the app.
writeFileSync(
  annFile(root, pdf),
  JSON.stringify({ tickmarks: [], signoffs: [], highlights: [{ id: 'h1', page: 13, x: 1, y: 2, w: 3, h: 4, author: 'BC', createdAt: new Date().toISOString() }] }, null, 2) + '}',
)
const recovered = loadAnnotations(root, pdf)
check('corrupted sidecar recovers its highlights', recovered.highlights?.length === 1, JSON.stringify(recovered))

writeFileSync(annFile(root, pdf), JSON.stringify({ tickmarks: [], signoffs: [], addedBy: null }, null, 2) + 'Crain"\n}')
check('corrupted sidecar with a stale string tail parses', Array.isArray(loadAnnotations(root, pdf).tickmarks))

// Unrecoverable garbage still degrades to empty rather than throwing.
writeFileSync(annFile(root, pdf), 'not json at all')
check('unparseable sidecar degrades to empty', loadAnnotations(root, pdf).tickmarks.length === 0)
saveAnnotations(root, pdf, { tickmarks: [], signoffs: [] })

// ── 9. Junk payloads do not create files ─────────────────────────────────────
for (const junk of [null, undefined, 'nope', 42, {}]) {
  check(`isEmptyAnnotations: ${JSON.stringify(junk) ?? 'undefined'}`, isEmptyAnnotations(junk) === true)
  saveAnnotations(root, pdf, junk)
}
check('junk payloads write nothing', privFiles().length === 0, `Private contains ${JSON.stringify(privFiles())}`)

rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('annotations: FAILED')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('annotations: OK (reads are side-effect-free; only real annotations reach Private)')
