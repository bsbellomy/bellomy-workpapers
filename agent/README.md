# Bellomy Workpapers — job queue

The **football button** in Workpapers queues three kinds of Claude runs for the
client whose folder is open:

| Job | Home repo | Skill it follows | Needs computer-use? |
|-----|-----------|------------------|---------------------|
| **Document Request** | `request-builder` | `tax-preprep` | no |
| **Tax Prep Guide** | `taxguide-builder` | `tax-tearsheet` | no |
| **Return Prep (RPA)** | `taxguide-builder` | `ultratax-robot` | **yes** |

## How it works

```
Any Workpapers machine ──POST /job──▶  Cloudflare Worker (KV queue)
                                             │   ▲
                                GET /jobs ───┘   │  (Workpapers "Queue" list + badge)
                                                 │
                        ┌────────────────────────┴──────────────┐
                        │  DEV BOX — a DESKTOP Claude Code        │
                        │  session. Billy runs the `run-next-job` │
                        │  skill: it claims the oldest job, cd's   │
                        │  to the right repo, follows that job's   │
                        │  skill (computer-use for the RPA), then  │
                        │  reports done/error. One at a time.      │
                        └─────────────────────────────────────────┘
```

**Why a desktop session and not a background daemon?** The return-prep RPA drives
UltraTax with Claude's **computer-use tools**, which exist only inside the desktop
app — a terminal `claude` process (and the Windows CLI generally) has no
computer-use, so it cannot run the RPA. There is also no supported way to launch a
desktop session from a script. So jobs are run by invoking a skill inside a desktop
Code session on the box, under Billy's oversight.

## Setup (dev box only)

1. **Configure the secret.** Copy `config.example.json` → `config.local.json`
   (gitignored) and set `uploadSecret` to the Worker's `UPLOAD_SECRET` (same value
   as `wrangler secret put UPLOAD_SECRET` / the app's Magic Link settings). Env vars
   `BW_WORKER_URL` / `BW_UPLOAD_SECRET` override it.

2. **Install the runner skill.** The tracked source of truth is
   `agent/skills/run-next-job/SKILL.md`. Copy it to the user skills folder so it's
   available in any desktop session:
   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\run-next-job" | Out-Null
   Copy-Item agent\skills\run-next-job\SKILL.md "$env:USERPROFILE\.claude\skills\run-next-job\SKILL.md" -Force
   ```
   (Already installed on the current box.)

## Running jobs

### Automatic (dispatcher loop) — recommended

Keep one **desktop** Claude Code session open on the box as the dispatcher and start it
looping once:

```
/loop Claim and run the next queued Bellomy Workpapers job with the run-next-job skill; if the queue is empty this cycle, just wait. One job at a time. Keep the box awake while looping.
```

It then polls the queue on its own (~once a minute) and starts each job the moment it
appears — no one has to type anything. Request/guide finish unattended; the return RPA
auto-starts but still pauses at its own safety gates (backup, confirm client ID), so keep
an eye on the box for those. The dispatcher session must stay open (keep-awake on) —
computer-use only exists inside a desktop session and no script can spawn one, so a
kept-open loop is what makes pickup automatic.

### Manual (one-off)

Or, when the football badge shows jobs, say **"run the next job"** (or `/run-next-job`) in
a desktop session. It claims the oldest job, switches to its repo, follows the skill, and
reports `done`/`error` — one at a time.

## Job CLI (used by the skill)

```
node agent/job-cli.mjs list                          # all jobs (JSON)
node agent/job-cli.mjs claim                          # claim oldest queued (or {job:null})
node agent/job-cli.mjs status <id> done  "<result>"  # mark finished
node agent/job-cli.mjs status <id> error "<why>"     # mark failed
```

## Deploy / test the Worker

The worker also holds code that deletes client documents — run the tests first:

```bash
node cloudflare-worker/jobs.test.mjs && node cloudflare-worker/worksheet.test.mjs && node cloudflare-worker/sweep.test.mjs
npx wrangler deploy
```

Jobs self-expire from the queue after 30 days; finished jobs can be cleared from the
app's Queue list.

## Job prompt templates live in KV, not in the repo

`GET`/`POST /job-templates` reads and writes the **saved** templates in KV; the worker serves
`{ ...DEFAULT_JOB_TEMPLATES, ...saved }`, so a saved key shadows the code default. Only `guide`
is customised today — `request` and `return` match `DEFAULT_JOB_TEMPLATES` byte for byte.

**`POST /job-templates` reads the process keys from the BODY ROOT**, not from a `templates`
wrapper:

```jsonc
{ "guide": "..." }              // correct
{ "templates": { "guide": "..." } }   // WRONG - every key is ignored, `t` ends up {},
                                      // and KV is overwritten with an empty object
```

`handleJobTemplatesSet` loops `for (const k of JOB_PROCESSES) if (typeof body[k] === 'string')`,
so the wrong shape still returns `{ok: true}` while silently wiping the saved templates — it
happened on 2026-10-15 and the only copy left was inside an already-rendered job prompt.

`job-template-guide.txt` in this folder is a checked-in copy of the live `guide` template so that
can never be the only copy again. **If you edit the template in the app, refresh this file.**
