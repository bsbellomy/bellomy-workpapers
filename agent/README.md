# Bellomy Workpapers — job agent

The **football button** in Workpapers queues three kinds of Claude runs for the
client whose folder you're in:

| Job | Home repo | Skill it follows |
|-----|-----------|------------------|
| **Document Request** | `request-builder` | `tax-preprep` |
| **Tax Prep Guide** | `taxguide-builder` | `tax-tearsheet` |
| **Return Prep (RPA)** | `taxguide-builder` | `ultratax-robot` |

## How it works

```
Any Workpapers machine ──POST /job──▶  Cloudflare Worker (KV queue)
                                             ▲   │
                          POST /claim-job ───┘   │  GET /jobs  (Workpapers "Queue" list)
                                                 ▼
                        ┌───────────────────────────────────────┐
                        │  DEV BOX — this agent (always up)       │
                        │  claims oldest job, opens an            │
                        │  INTERACTIVE `claude` window in the     │
                        │  right repo seeded with the prompt,     │
                        │  waits for you to close it, then        │
                        │  reports done/error and takes the next  │
                        └───────────────────────────────────────┘
```

- **Serial queue.** One job runs at a time. The next isn't claimed until you close
  the current session's window, so you keep oversight of every run.
- **No new tunnel.** It reuses the existing Worker (`share.bellomycpa.com`) as the
  queue. Every endpoint is auth-gated with the same `UPLOAD_SECRET` the app uses.
- **Identity bridge.** The job carries the client *name*, T: folder path and tax
  year. The launched Claude session resolves the TaxFlowID itself (taxdome-api /
  `clients` folder) — Workpapers never learns TaxFlowIDs.
- **Prompts** come from thin templates stored on the Worker (`/job-templates`),
  editable centrally (no app release) and per-run in the popup. Tax year defaults
  to the current calendar year − 1 (the effective tax year).

## Setup (dev box only)

1. **Configure the secret.** Either set env vars `BW_WORKER_URL` / `BW_UPLOAD_SECRET`,
   or copy `config.example.json` → `config.local.json` (gitignored) and fill in
   `uploadSecret` (the same value as `wrangler secret put UPLOAD_SECRET`).

2. **Install the always-up task:**
   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File agent\install-agent.ps1
   ```
   Registers `BellomyWorkpapersAgent`, starts it at logon, restarts it if it stops.

3. **Deploy the Worker** so the `/job*` endpoints exist (run the tests first — the
   worker also holds code that deletes client documents):
   ```bash
   node cloudflare-worker/jobs.test.mjs && node cloudflare-worker/worksheet.test.mjs && node cloudflare-worker/sweep.test.mjs
   npx wrangler deploy
   ```

## Run by hand (for testing)

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File agent\job-runner.ps1
```

Log: `agent\.state\agent.log`. Uninstall:
`Unregister-ScheduledTask -TaskName 'BellomyWorkpapersAgent' -Confirm:$false`

## Notes

- The agent must run on the machine where UltraTax and the TaxDome `T:` drive are
  available — i.e. the dev box — because Return Prep drives UltraTax and all three
  jobs read the client's T: folder.
- Jobs self-expire from the queue after 30 days. Finished jobs can be cleared from
  the app's Queue list.
