# runhub

You talk to Grok on your phone. Grok runs one command on this laptop. The laptop starts a coding agent in an isolated git worktree, checks the diff against the pre-agent HEAD, runs tests, optionally asks Claude to review, then prints a short report.

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

That starts Cursor Agent with Grok 4.6 Medium in a new worktree on `runhub/<runId>`. The prompt goes on stdin, not argv. `--force` (Cursor) and `--dangerously-skip-permissions` (Claude) are on by default.

After the agent exits, runhub diffs against the SHA it snapped before the agent started, including commits the agent made. Diff-stat goes in the phone report. `git status --porcelain` stays in `porcelain.txt` on disk. Tests run only if `package.json` has `scripts.test` (`npm test`) or the Makefile has a `test:` target (`make test`). Otherwise the report says `tests: none`. Override with `--test-cmd`. The worktree is a fresh checkout, so `npm test` fails if `node_modules` is not committed.

```bash
runhub run --cwd /home/jrm22n/hycom --agent claude --prompt "add a smoke test"
runhub run --cwd /home/jrm22n/hycom --review claude --prompt "fix the login bug"
```

`--agent` is `cursor` or `claude` (default cursor). `--model` overrides the per-agent default. `--review claude` runs after verify. The reviewer reads `git diff <base>..HEAD` plus the test tail and must end with APPROVE or REJECT.

Stdout is the phone report. Result. Branch and merge command. Diff-stat. Tests. The agent's last message. On a failed agent, the last 20 lines of `agent.stderr`. Review verdict if you asked for one. The last stdout line is `runhub: <runId> <reportPath>` so the phone `full:` link is a real file.

```bash
runhub status
runhub report
runhub list
runhub prune --keep 20
```

`list` shows run id, project basename, outcome, and time. A run still marked running after its timeout shows as stale. `prune` deletes the run dir, the worktree, and the `runhub/<runId>` branch.

Logs live in `~/.local/share/runhub/runs/`.

Optional flags: `--timeout 30m` (already the default), `--test-cmd "npm test"`, `--agent`, `--model`, `--review`.

Paste `GROKBOT.md` into Grok as a custom instruction.

## If you are sharing this

The public repo is https://github.com/0jrm/runhub
