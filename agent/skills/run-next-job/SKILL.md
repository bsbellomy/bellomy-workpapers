---
name: run-next-job
description: Claim and run the next queued Bellomy Workpapers job on this box - a document request (tax-preprep), a tax prep guide (tax-tearsheet), or a return prep (ultratax-robot / UltraTax RPA). Use when Billy says run the next job, run the job queue, drain the queue, or start the job someone queued from Workpapers. Must run in the DESKTOP app so computer-use is available for the RPA.
---

# Run the next Workpapers job

Jobs are queued from the football button in the Workpapers app (any firm machine) and
run **here, on the dev box**, inside this desktop Claude Code session - because the
return-prep RPA drives UltraTax with the **computer-use tools**, which only exist in the
desktop app. This skill claims the next job and runs it under Billy's oversight.

Job CLI (keeps the queue secret in one place):
`D:\Projects\bellomy-workpapers\agent\job-cli.mjs` - commands `list`, `claim`, `status <id> <state> [note]`.

## Steps

### 1. Claim the next job
```
node D:\Projects\bellomy-workpapers\agent\job-cli.mjs claim
```
This returns `{ ok, job }`. **If `job` is `null`, the queue is empty** - tell Billy so and stop.
Claiming already flips the job to `running` on the queue, so the Workpapers badge updates.

Read these fields off the claimed job: `id`, `process`, `client`, `year`, `path`, `prompt`, `requester`.

### 2. Announce it
Tell Billy in one line what you're about to run, e.g.
`Running return prep for Cluck, Robert (2025) - queued by billy@LAPTOP.`

### 3. Move to the job's home repo
The process skills live in specific repos, so switch this session's working directory:

| process | repo | skill the prompt will name |
|---------|------|----------------------------|
| `request` | `D:\Projects\request-builder` | `tax-preprep` |
| `guide` | `D:\Projects\taxguide-builder` | `tax-tearsheet` |
| `return` | `D:\Projects\taxguide-builder` | `ultratax-robot` |

Use the change-directory capability (`change_directory`) to set the working directory to that
repo so its project skills load. If that tool isn't available, ask Billy to reopen this
session in that repo and re-run the skill - or, as a fallback, read the named skill's
`SKILL.md` directly from the repo and follow it by hand.

### 4. Do the job
Follow the claimed job's `prompt` verbatim - it already names the client, tax year, T: folder
path, and which skill to follow. Load and obey that skill end to end:

- **request** -> the `tax-preprep` skill: review what's on hand, produce PRE-PREP.md + the hosted
  worksheet, publish the upload request.
- **guide** -> the `tax-tearsheet` skill: build the data-entry tearsheet.
- **return** -> the `ultratax-robot` skill: **read its `RULES.md` FIRST**, back up the client, then
  drive UltraTax with the computer-use tools. This is the one that needs the desktop app.

Resolve the client's TaxFlowID yourself (taxdome-api / the repo's `clients` folder) - the job
carries only the client *name* and T: path.

### 5. Oversight
Billy is watching. Honor each skill's own confirmation gates (e.g. ultratax-robot's backup +
"confirm the target client ID" steps). Don't fire irreversible actions without them.

### 6. Report status
- Finished cleanly:
  ```
  node D:\Projects\bellomy-workpapers\agent\job-cli.mjs status <id> done "<one-line result>"
  ```
- Aborted or failed:
  ```
  node D:\Projects\bellomy-workpapers\agent\job-cli.mjs status <id> error "<why>"
  ```

### 7. Next one
Offer to drain the queue: run `list` to show what's left, and re-invoke this skill for the next
job. Run **one at a time** - never start a second job while one is in progress.
