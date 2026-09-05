# runhub

You talk to Grok on your phone. Grok runs one command on this laptop. The laptop starts a coding agent in an isolated git worktree, checks the diff against the pre-agent HEAD, runs tests, optionally asks Claude to review, then writes a short report.

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

Point at a git repo that is already in `~/.config/runhub/projects.toml`. `--cwd` is a filesystem path or a table name from that file. `runhub run` refuses any other path. Exit 2, message `not in projects.toml: <resolved path>`. Keys in that file are `path`, `test`, `typecheck`, `lint`, and `remote`. A `test` key wins over detection. `--test-cmd` wins over both.

```bash
runhub run --cwd /home/jrm22n/hycom --prompt "fix the login bug"
```

That prints `runhub: <runId>` and returns in under two seconds. The pipeline keeps going in the background. Wait for it:

```bash
runhub wait <runId>
```

`wait` prints the report when the run finishes. Exit 0 on pass, changed, untested, or no-changes. Exit 1 on fail. If the timeout hits first, it prints `still running: <runId>` and exits 3. The run keeps going. Default wait timeout is 10m.

That starts Cursor Agent with Grok 4.6 Medium in a new worktree on `runhub/<runId>`. The prompt goes on stdin, not argv. `--force` (Cursor) and `--dangerously-skip-permissions` (Claude) are on by default.

A long spec does not have to fit on one command line. `--prompt-file <path>` reads it from a file and `--prompt -` reads it from stdin. Pass exactly one of `--prompt` or `--prompt-file`.

```bash
runhub run --cwd /home/jrm22n/hycom --prompt-file /tmp/spec.md
cat /tmp/spec.md | runhub run --cwd /home/jrm22n/hycom --prompt -
```

When the agent exits, runhub commits whatever it left dirty in the worktree as `runhub: <first 60 chars of the prompt>`, so the branch holds the work whether or not the agent committed anything itself. Dependency directories are never committed. Everything after that reads the committed range `<base>..<commit>`. Diff-stat goes in the phone report. The pre-commit `git status --porcelain` stays in `porcelain.txt` on disk.

A fresh worktree has no `node_modules`, so runhub symlinks the gitignored `node_modules`, `.venv`, `venv`, `target`, and `.tox` from the real repo into the worktree. `npm test` and `pytest` work in the worktree without an install step. Tests run if `package.json` has `scripts.test` (`npm test`), the Makefile has a `test:` target (`make test`), or a `pyproject.toml` has `[tool.pytest*]`, a `pytest` dependency, or a `tests/` directory next to it. Runhub also looks under `packages/*` for that pyproject and runs tests with that directory as cwd. The command is `.venv/bin/pytest` if that file is executable under the search root, otherwise `python -m pytest` if importable, otherwise `pytest`. Otherwise the report says `tests: none`. Override with `--test-cmd`.

After tests, runhub runs typecheck and lint when the project declares them. It uses `package.json` `scripts.typecheck` and `scripts.lint`, or `[tool.mypy]` / `[tool.ruff]` in pyproject, or the `typecheck` / `lint` keys in `projects.toml`. Each gets a report line. Exit 126 or 127 is `(not found on PATH)` and does not fail the run.

If tests ran and failed, runhub does not retry when `git diff --stat <base>` is empty. When the diff is not empty it checks the same test, typecheck, and lint commands once at the base sha in a throwaway worktree and caches that at `<dataRoot>/baseline/<project>-<sha>.json`. If the base already fails, there is no retry. The test line is `tests: <cmd>  exit N (also failing on base)` and the outcome is `changed, untested`. If the base passes, runhub runs the same agent once more in that worktree with the test tail, commits, and verifies again.

If the project entry sets `remote`, runhub pushes `runhub/<runId>` to that git remote and, if `gh` is on PATH and `gh auth status` succeeds, opens a PR whose body is `report.md`. The report then has both `pr: <url>` and `merge: runhub merge <runId>`. A push with no PR prints `pushed: <remote>/<branch>`. Without `remote`, there is no push and the report keeps `merge: git -C <cwd> merge runhub/<runId>`.

```bash
runhub run --cwd /home/jrm22n/hycom --agent claude --prompt "add a smoke test"
runhub run --cwd /home/jrm22n/hycom --review claude --prompt "fix the login bug"
runhub merge <runId>
```

`--agent` is `cursor` or `claude` (default cursor). `--model` overrides the per-agent default. `--review claude` runs after verify, reads the committed diff plus the test tail, and must end with APPROVE or REJECT. The reviewer runs read-only, with no tools.

`merge` squash-merges the PR when one was opened. Otherwise it runs `git -C <cwd> merge runhub/<runId>`.

The outcome line does not lie about what was checked. `pass` means the diff is non-empty and a test command exited 0. A repo with no test command, or a test command that is not on PATH, gets `changed, untested`, never `pass`. `no-changes` means an empty diff. Tests that already fail at the base sha do not make the run `fail`: empty diff stays `no-changes`, a non-empty diff is `changed, untested`. `fail` means the agent exited non-zero, timed out, or a test, typecheck, or lint command ran and exited non-zero after a passing base. Review stays on its own line.

The report starts with outcome, project name, and duration. Branch, then `pr:` and `merge:` when a PR opened, or `pushed:` when the branch was pushed and no PR opened. Diff-stat. Tests, retry, typecheck, lint. The agent binary and last message. On a failed agent, the last 20 lines of `agent.stderr`. Review binary and verdict if you asked for one. `runhub report <runId>` prints that stored file unchanged.

```bash
runhub status
runhub report
runhub list
runhub prune --keep 20
```

`list` shows run id, project basename, outcome, and time. It prints the outcome tag, so `changed, untested` in a report is `changed-untested` in `list`. A run is `running` only while its pipeline PID is alive. Otherwise an unfinished run is `stale`. `list` ends with a tally of the last 30 runs.

Logs live in `~/.local/share/runhub/runs/`. Each run directory is mode 0700. `prompt.txt`, `review-prompt.txt`, and `report.md` are plaintext. Anyone who can read that tree can read the prompts. Finished runs prune older local runs down to 30. `prune --keep N` still deletes the run dir, the worktree, and the local `runhub/<runId>` branch. It never deletes the remote branch or the PR.

Run `npm run contract` before every tag and after upgrading `cursor-agent`, `claude`, or `gh`. That hits the real binaries, not the fake ones in `npm test`.

Optional flags: `--timeout 30m` (already the default), `--test-cmd "npm test"`, `--agent`, `--model`, `--review`, `--prompt-file`. `wait` also takes `--timeout`.

Paste `GROKBOT.md` into Grok as a custom instruction.

## If you are sharing this

The public repo is https://github.com/0jrm/runhub
