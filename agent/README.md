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

When the football badge shows queued jobs, open a **desktop** Claude Code session on
the box and say **"run the next job"** (or `/run-next-job`). It will:

1. Claim the oldest queued job (`job-cli.mjs claim`) — the badge flips it to running.
2. Switch to the job's repo and follow its skill end to end.
3. Report `done` / `error` back to the queue.
4. Offer to run the next one. **One job at a time.**

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
