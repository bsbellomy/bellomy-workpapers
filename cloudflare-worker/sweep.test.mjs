// Offline test for sweepOrphans() - it deletes client documents, so the guard
// conditions are worth proving before this ever runs against the real bucket.
//
//   node cloudflare-worker/sweep.test.mjs
//
// Fakes R2 + KV with the same surface the worker uses (list/delete, get).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'worker.js'), 'utf8')

// Pull the pieces we need out of worker.js without running the fetch handler.
const consts = src.match(/const UR_DEFAULT_DAYS[\s\S]*?^}/m)[0]
const sweep = src.match(/async function sweepOrphans[\s\S]*?\n}/)[0]
const mod = await import(
  'data:text/javascript,' + encodeURIComponent(consts + '\n' + sweep + '\nexport {sweepOrphans, UR_MAX_DAYS, ML_MAX_DAYS, SWEEP_GRACE_DAYS, clampDays}')
)
const { sweepOrphans, UR_MAX_DAYS, ML_MAX_DAYS, SWEEP_GRACE_DAYS, clampDays } = mod

const DAY = 86400000
const ago = d => new Date(Date.now() - d * DAY).toISOString()

function makeEnv(objects, kvKeys) {
  const store = new Map(objects.map(o => [o.key, o]))
  const kv = new Set(kvKeys)
  const deleted = []
  return {
    deleted,
    MAGIC_LINKS_BUCKET: {
      async list({ prefix, cursor, limit }) {
        const all = [...store.values()].filter(o => o.key.startsWith(prefix))
        const start = cursor ? Number(cursor) : 0
        const slice = all.slice(start, start + (limit || 1000))
        const end = start + slice.length
        return { objects: slice, truncated: end < all.length, cursor: String(end) }
      },
      async delete(key) { store.delete(key); deleted.push(key) },
    },
    LINKS_KV: { async get(k) { return kv.has(k) ? '{"live":true}' : null } },
  }
}

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')) }
}

console.log('\nsweepOrphans()\n' + '='.repeat(64))
console.log(`  policy: UR_MAX ${UR_MAX_DAYS}d, ML_MAX ${ML_MAX_DAYS}d, grace ${SWEEP_GRACE_DAYS}d`)
console.log(`  purge threshold: ur/ ${UR_MAX_DAYS + SWEEP_GRACE_DAYS}d, ml/ ${ML_MAX_DAYS + SWEEP_GRACE_DAYS}d, ws/ ${UR_MAX_DAYS + SWEEP_GRACE_DAYS}d\n`)

const env = makeEnv([
  // live record, new file - must survive
  { key: 'ur/LIVE/worksheet.txt', uploaded: ago(1) },
  // live record, ANCIENT file - must survive, because the record is live
  { key: 'ur/LIVE/old-receipt.pdf', uploaded: ago(400) },
  // lapsed record but still inside the window - must survive
  { key: 'ur/LAPSED_RECENT/a.pdf', uploaded: ago(UR_MAX_DAYS + SWEEP_GRACE_DAYS - 5) },
  // lapsed record, past the window - PURGE
  { key: 'ur/ORPHAN/b.pdf', uploaded: ago(UR_MAX_DAYS + SWEEP_GRACE_DAYS + 5) },
  { key: 'ur/ORPHAN/c.jpg', uploaded: ago(400) },
  // magic links
  { key: 'ml/LIVEML', uploaded: ago(400) },                                  // record live -> survive
  { key: 'ml/ORPHANML', uploaded: ago(ML_MAX_DAYS + SWEEP_GRACE_DAYS + 1) }, // -> PURGE
  { key: 'ml/YOUNGML', uploaded: ago(2) },                                   // -> survive
  // worksheet state — keyed ws/<token>.json, guarded by the SAME ur: record.
  // If the token were taken as the whole 'LIVE.json' segment, the KV lookup
  // would miss and a live client's answers would be deleted. That is the point
  // of this case.
  { key: 'ws/LIVE.json', uploaded: ago(400) },                                       // -> survive
  { key: 'ws/LAPSED_RECENT.json', uploaded: ago(UR_MAX_DAYS + SWEEP_GRACE_DAYS - 5) },// -> survive
  { key: 'ws/ORPHAN.json', uploaded: ago(UR_MAX_DAYS + SWEEP_GRACE_DAYS + 5) },       // -> PURGE
  // the published page is keyed ws/<token>.html and needs the same strip
  { key: 'ws/LIVE.html', uploaded: ago(400) },                                       // -> survive
  { key: 'ws/ORPHAN.html', uploaded: ago(UR_MAX_DAYS + SWEEP_GRACE_DAYS + 5) },      // -> PURGE
], ['ur:LIVE', 'ml:LIVEML'])

const res = await sweepOrphans(env)
const d = env.deleted.sort()

check('purges orphaned upload-request files', d.includes('ur/ORPHAN/b.pdf') && d.includes('ur/ORPHAN/c.jpg'))
check('purges orphaned magic-link blob', d.includes('ml/ORPHANML'))
check('NEVER touches a file whose record is still live', !d.some(k => k.startsWith('ur/LIVE/')),
      d.filter(k => k.startsWith('ur/LIVE/')).join(','))
check('NEVER touches a live magic link, however old', !d.includes('ml/LIVEML'))
check('respects the grace period after a record lapses', !d.includes('ur/LAPSED_RECENT/a.pdf'))
check('leaves young magic links alone', !d.includes('ml/YOUNGML'))
check('purges orphaned worksheet state', d.includes('ws/ORPHAN.json'))
check('NEVER deletes a live worksheet, however old  [.json token strip]', !d.includes('ws/LIVE.json'),
      'a broken tokenOf() would look up ur:LIVE.json, miss, and purge live answers')
check('worksheet state respects the grace period', !d.includes('ws/LAPSED_RECENT.json'))
check('purges an orphaned worksheet PAGE', d.includes('ws/ORPHAN.html'))
check('NEVER deletes a live worksheet page  [.html token strip]', !d.includes('ws/LIVE.html'))
check('purged exactly the 5 expected objects', d.length === 5, 'deleted: ' + d.join(', '))
check('reports what it did', res.purged === 5 && res.scanned === 13, JSON.stringify(res))

console.log('\nclampDays()\n' + '='.repeat(64))
check('missing -> default', clampDays(undefined, 75, 90) === 75)
check('zero -> default', clampDays(0, 75, 90) === 75)
check('garbage -> default', clampDays('abc', 75, 90) === 75)
check('negative -> default', clampDays(-5, 75, 90) === 75)
check('in range -> honoured', clampDays(60, 75, 90) === 60)
check('over the cap -> capped', clampDays(3650, 75, 90) === 90)
check('string numeral -> honoured', clampDays('30', 75, 90) === 30)

console.log('\n' + '='.repeat(64))
console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${pass} passed, ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
