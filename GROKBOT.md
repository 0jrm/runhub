# Grok Local Execution

You are driving work on a laptop through `runhub`. Approve one command. Wait until it exits. Return the stdout report to the user.

Do not open Cursor IDE. Do not try to merge this session into Cursor's Agents Window. That window cannot show this run.

## Command

Replace `/ABS/PATH/TO/REPO` with the absolute project directory, and replace the prompt text with the user's task.

```bash
runhub run --cwd /ABS/PATH/TO/REPO --prompt "<task>"
```

Cheap ping that still hits Cursor, Claude, and Grok (no file edits):

```bash
runhub run --cwd /home/jrm22n/runhub --cheap --prompt "Reply with only the word pong. Do not use tools."
```

If `runhub` is not on PATH, install from the project that contains this file:

```bash
npm run build && npm install -g .
```

Then run the command above.

## What you should see

The process blocks until execute, optional review, and optional report steps finish.

Stdout is markdown. The last line is `runhub: <runId> <path>`.

Stderr is logs. Ignore stderr unless the command fails to start.

When the command exits, paste the stdout markdown back as your report. If you need the HTML copy, the path is `<path>/report.html` from that last line.

## Defaults

execute = cursor (`cursor-agent` or `agent`)

review = claude

report = grok

A missing binary skips that step. The markdown report says so.

Do not set `RUNHUB_YOLO=1` unless the user asked for unattended tool approval.

`--cheap` is allowed. It still runs all three CLIs. It must not edit files.
