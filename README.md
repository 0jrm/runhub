# runhub

`runhub` is the one command Grok Local Execution should run and wait on. It records a Run as an append-only event log, calls installed agent CLIs, prints a markdown report on stdout, and stores artifacts under `$XDG_DATA_HOME/runhub` (or `~/.local/share/runhub`).

It does not drive the Cursor IDE. It does not merge IDE, CLI, or cloud sessions into Cursor's Agents Window. That product cannot do that.

## Install

From a clone, after `npm run build`:

```bash
npm install -g .
```

Share the repo or a tarball. Recipients need Node 20+. From a clone:

```bash
npm install
npm run build
npm install -g .
```

To ship a file:

```bash
npm pack
```

That writes `runhub-0.1.0.tgz` (gitignored). Install it with:

```bash
npm install -g ./runhub-0.1.0.tgz
```

Or run without a global install:

```bash
npx --yes ./runhub-0.1.0.tgz run --cwd /abs/dir --prompt "task"
```

## Grokbot one-liner

Approve this command and wait until it exits:

```bash
runhub run --cwd /ABS/PATH/TO/REPO --prompt "<task>"
```

Stdout is the markdown report, plus a last line `runhub: <runId> <path>`. Logs go to stderr. Defaults are execute=cursor, review=claude, report=grok. Missing binaries skip that step and show up in the report.

See `GROKBOT.md` for the paste-ready instruction.

## Commands

```
runhub run --cwd <dir> --prompt <text> [--execute cursor|claude|grok] [--review none|claude|grok] [--report grok|none] [--dry-run] [--cheap]
runhub status [runId]
runhub report [runId]
runhub inspect [runId]
runhub html [runId]
runhub list
runhub prune --keep <n>
runhub quota
```

`--dry-run` probes PATH binaries, writes a run with a quota snapshot, and still prints `report.md`. It does not invoke agents.

`--cheap` still calls Cursor, Claude, and Grok, but keeps each hop tiny: Cursor ask mode (no edits), Claude `--max-turns 1`, Grok already single-turn. Use it for a ping, not real coding.

Quota lines are PATH probes with an 8s timeout, not a billing API.

`RUNHUB_YOLO=1` is required before runhub passes `--force`, `--yolo`, `--always-approve`, or `--dangerously-skip-permissions`.

## Storage

Each run lives in `runs/<runId>/` with `events.jsonl`, `summary.json`, `report.md`, and `report.html`. The event log is the source of truth. Agent transcripts in `~/.cursor/projects/**/agent-transcripts` (and Claude/Grok session dirs) are not copied.

`runhub prune --keep 20` deletes oldest run directories beyond 20.
