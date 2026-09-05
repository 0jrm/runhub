# runhub

You talk to Grok on your phone. Grok runs one command on this laptop. The laptop runs one coding agent, checks git and tests, then prints a short report.

## Install

You need Node 20+.

```bash
git clone https://github.com/0jrm/runhub.git
cd runhub
npm install
npm run build
npm install -g .
```

## Everyday use

Point at a git repo. Say the job. Wait.

```bash
runhub run --cwd /home/jrm22n/some-project --prompt "fix the login bug"
```

That starts Cursor Agent with Grok 4.6 Medium. The prompt goes on stdin, not argv. After the agent exits, runhub records `git status --porcelain` and `git diff --stat HEAD`, then runs the project test command (`npm test`, `pytest`, or `make test`, or `--test-cmd`).

Stdout is the phone report, in this order. Result. Files changed. Tests. The agent's last message. Errors. Raw agent output stays in `agent.stdout` on disk.

```bash
runhub status
runhub report
runhub list
runhub prune --keep 20
```

Logs live in `~/.local/share/runhub/runs/`.

Optional flags are `--timeout 30m` (that is already the default) and `--test-cmd "npm test"`.

Do not set `RUNHUB_YOLO=1` unless you want the agent to approve its own tool use.

Paste `GROKBOT.md` into Grok as a custom instruction.

## If you are sharing this

The public repo is https://github.com/0jrm/runhub
