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

A long spec does not have to fit on one command line. `--prompt-file <path>` reads it from a file and `--prompt -` reads it from stdin. Pass exactly one of `--prompt` or `--prompt-file`.

```bash
runhub run --cwd /home/jrm22n/hycom --prompt-file /tmp/spec.md
cat /tmp/spec.md | runhub run --cwd /home/jrm22n/hycom --prompt -
```

When the agent exits, runhub commits whatever it left dirty in the worktree as `runhub: <first 60 chars of the prompt>`, so the branch holds the work whether or not the agent committed anything itself. Dependency directories are never committed. Everything after that reads the committed range `<base>..<commit>`. Diff-stat goes in the phone report. The pre-commit `git status --porcelain` stays in `porcelain.txt` on disk.

A fresh worktree has no `node_modules`, so runhub symlinks the gitignored `node_modules`, `.venv`, `venv`, `target`, and `.tox` from the real repo into the worktree. `npm test` and `pytest` work in the worktree without an install step. Tests run only if `package.json` has `scripts.test` (`npm test`) or the Makefile has a `test:` target (`make test`). Otherwise the report says `tests: none`. Override with `--test-cmd`.

```bash
runhub run --cwd /home/jrm22n/hycom --agent claude --prompt "add a smoke test"
runhub run --cwd /home/jrm22n/hycom --review claude --prompt "fix the login bug"
```

`--agent` is `cursor` or `claude` (default cursor). `--model` overrides the per-agent default. `--review claude` runs after verify, reads the committed diff plus the test tail, and must end with APPROVE or REJECT. The reviewer runs read-only, with no tools.

The outcome line does not lie about what was checked. `pass` means the diff is non-empty and a test command exited 0. A repo with no test command gets `changed, untested`, never `pass`. `no-changes` means an empty diff. `fail` means a blocker: a failed run, a timeout, a non-zero agent, a REJECT, or a failing test command.

Stdout is the phone report. Outcome. How long it took. Branch and merge command. Diff-stat. Tests, with a 12-line excerpt on failure and the full log in `verify.out`. The agent's last message. On a failed agent, the last 20 lines of `agent.stderr`. Review verdict if you asked for one. The last stdout line is `runhub: <runId> <reportPath>` so the phone `full:` link is a real file.

```bash
runhub status
runhub report
runhub list
runhub prune --keep 20
```

`list` shows run id, project basename, outcome, and time. It prints the outcome tag, so `changed, untested` in a report is `changed-untested` in `list`. A run still marked running after its timeout shows as stale. `prune` deletes the run dir, the worktree, and the `runhub/<runId>` branch.

Logs live in `~/.local/share/runhub/runs/`.

Optional flags: `--timeout 30m` (already the default), `--test-cmd "npm test"`, `--agent`, `--model`, `--review`, `--prompt-file`.

Paste `GROKBOT.md` into Grok as a custom instruction.

## If you are sharing this

The public repo is https://github.com/0jrm/runhub
