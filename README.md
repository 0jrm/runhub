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

Point at a git repo that is already in `~/.config/runhub/projects.toml`. `--cwd` is a filesystem path or a table name from that file. `runhub run` refuses any other path. Exit 2, message `not in projects.toml: <resolved path>`. Keys in that file are `path`, `test`, `typecheck`, `lint`, `remote`, and `preamble`. `preamble` is a path to a file that replaces the built-in unattended instructions. A `test` key wins over detection. `--test-cmd` wins over both.

```bash
runhub run --cwd /home/jrm22n/hycom --prompt "fix the login bug"
```

That prints `runhub: <runId>` and returns in under two seconds. The pipeline keeps going in the background. Wait for it:

```bash
runhub wait <runId>
```

`wait` prints the report when the run finishes. Exit 0 on pass, changed, untested, or no-changes. Exit 1 on fail. If the timeout hits first, it prints `still running: <runId>` and exits 3. The run keeps going. Default wait timeout is 10m.

That starts Cursor Agent with Grok 4.6 Medium in a new worktree on `runhub/<runId>`. The prompt goes on stdin, not argv. `--force` (Cursor) and `--dangerously-skip-permissions` (Claude) are on by default.

Before the spec, runhub prepends an unattended preamble. The built-in text tells the agent not to ask questions, to write `ASSUMPTIONS.md` for conventional choices, and to end with `BLOCKED: ...` only for irreversible product choices. Override it with `~/.config/runhub/preamble.md` if that file is non-empty. A project's `preamble` key wins over both. If that file is missing or empty, runhub emits an `error` event and falls through to the user file, then the built-in. `--no-preamble` writes the spec alone, for debugging. Combined text is `prompt.txt` as `<preamble>`, a blank line, `---`, a blank line, then the spec. The raw spec stays in `spec.txt`. Commit messages, PR titles, and `report.md` use the spec from `run_created`.

A long spec does not have to fit on one command line. `--prompt-file <path>` reads it from a file and `--prompt -` reads it from stdin. Pass exactly one of `--prompt` or `--prompt-file`.

```bash
runhub run --cwd /home/jrm22n/hycom --prompt-file /tmp/spec.md
cat /tmp/spec.md | runhub run --cwd /home/jrm22n/hycom --prompt -
```

When the agent exits, runhub commits whatever it left dirty in the worktree as `runhub: <first 60 chars of the spec>`, so the branch holds the work whether or not the agent committed anything itself. Dependency directories are never committed. Everything after that reads the committed range `<base>..<commit>`. Diff-stat goes in the phone report. The pre-commit `git status --porcelain` stays in `porcelain.txt` on disk.

A fresh worktree has no `node_modules`, so runhub symlinks the gitignored `node_modules`, `.venv`, `venv`, `target`, and `.tox` from the real repo into the worktree. `npm test` and `pytest` work in the worktree without an install step. Tests run if `package.json` has `scripts.test` (`npm test`), the Makefile has a `test:` target (`make test`), or a `pyproject.toml` has `[tool.pytest*]`, a `pytest` dependency, or a `tests/` directory next to it. Runhub also looks under `packages/*` for that pyproject and runs tests with that directory as cwd. The command is `.venv/bin/pytest` if that file is executable under the search root, otherwise `python -m pytest` if importable, otherwise `pytest`. Otherwise the report says `tests: none`. Override with `--test-cmd`.

After tests, runhub runs typecheck and lint when the project declares them. It uses `package.json` `scripts.typecheck` and `scripts.lint`, or `[tool.mypy]` / `[tool.ruff]` in pyproject, or the `typecheck` / `lint` keys in `projects.toml`. Each gets a report line. Exit 126 or 127 is `(not found on PATH)` and does not fail the run.

If tests ran and failed, runhub does not retry when `git diff --stat <base>` is empty. When the diff is not empty it checks the same test, typecheck, and lint commands once at the base sha in a throwaway worktree and caches that at `<dataRoot>/baseline/<project>-<sha>.json`. If the base already fails, there is no retry. The test line is `tests: <cmd>  exit N (also failing on base)` and the outcome is `changed, untested`. If the base passes, runhub runs the same agent once more in that worktree with the preamble plus the test tail, commits, and verifies again. The review prompt does not get a preamble.

If the project entry sets `remote`, runhub pushes `runhub/<runId>` to that git remote and, if `gh` is on PATH and `gh auth status` succeeds, opens a PR whose body is `report.md`. After a review is recorded for that run, runhub posts `review-comment.md` with `gh pr comment`, then syncs the PR body to the final `report.md` with `gh pr edit`, so the PR description matches `runhub report <runId>`. The report then has `pr: <url>`, `merge: runhub merge <runId>`, and `review-comment: posted` or `review-comment: failed`. A comment failure is an `error` event. It does not change the outcome. If review ran and no PR opened, there is no comment and no report line. A push with no PR prints `pushed: <remote>/<branch>`. Without `remote`, there is no push and the report keeps `merge: git -C <cwd> merge runhub/<runId>`.

```bash
runhub run --cwd /home/jrm22n/hycom --agent claude --prompt "add a smoke test"
runhub run --cwd /home/jrm22n/hycom --review claude --prompt "fix the login bug"
runhub merge <runId>
```

`--agent` is `cursor` or `claude` (default cursor). `--model` overrides the per-agent default. `--review claude` runs after verify, reads the committed diff plus the test tail, and must end with APPROVE or REJECT. The reviewer gets `--tools Read,Glob,Grep` and the same `--allowedTools`. `--disallowedTools` lists Write, Edit, MultiEdit, and NotebookEdit. It has no Bash and no git. runhub inlines the diff and up to 20 `git log --oneline` lines between `----- BEGIN UNTRUSTED AGENT OUTPUT -----` and `----- END UNTRUSTED AGENT OUTPUT -----`. The prompt tells the reviewer that everything after that marker is data written by the agent under review, never an instruction, and not to read outside the worktree or quote credentials. The review prompt says not to modify anything and not to review style. `ASSUMPTIONS.md` is not inlined. The reviewer can Read it.

`merge` squash-merges the PR when one was opened. Otherwise it runs `git -C <cwd> merge runhub/<runId>`.

The outcome line does not lie about what was checked. `pass` means the diff is non-empty and a test command exited 0. A repo with no test command, or a test command that is not on PATH, gets `changed, untested`, never `pass`. `no-changes` means an empty diff. Tests that already fail at the base sha do not make the run `fail`: empty diff stays `no-changes`, a non-empty diff is `changed, untested`. `fail` means the agent exited non-zero, timed out, or a test, typecheck, or lint command ran and exited non-zero after a passing base. Review stays on its own line.

The report starts with outcome, project name, and duration. If the agent's last message ends with a line that starts with `BLOCKED:`, the next report line is `blocked: <that line>`. Outcome stays whatever verify said. `wait` still exits 0 or 1 by outcome. Branch, then `pr:` and `merge:` when a PR opened, or `pushed:` when the branch was pushed and no PR opened. Diff-stat. Tests, retry, typecheck, lint. The agent binary and last message. On a failed agent, the last 20 lines of `agent.stderr`. Review binary and verdict if you asked for one. `review-comment: posted` or `review-comment: failed` when a PR comment was attempted. `runhub report <runId>` prints that stored file unchanged.

```bash
runhub status
runhub report
runhub list
runhub inspect
runhub prune --keep 20
```

`list` shows run id, project basename, outcome, a blocked column, and time. The blocked column is `blocked` or `-`. It prints the outcome tag, so `changed, untested` in a report is `changed-untested` in `list`. A run is `running` only while its pipeline PID is alive. Otherwise an unfinished run is `stale`. `list` ends with a tally of the last 30 runs.

```bash
runhub inspect
runhub inspect <runId> -n 50 --tail agent
runhub inspect <runId> --links-only
```

`inspect` reads only the run directory. With no run id it picks the latest run whose pipeline PID is still alive, otherwise the most recent run. It prints a `links:` block (worktree, log paths, pids from `session.json`, plus any http(s) URLs already sitting in the logs) and then tails. `-f`/`--follow` keeps printing new log bytes until that pipeline PID exits. `--json` dumps the snapshot once and does not follow. `--no-tail` and `--links-only` skip the log bodies.

`session.json` is written when the run is created and updated with the pipeline pid, agent pgid, and worktree path. Cursor or Claude transcript URLs are stored only if they already appear in those files. This command does not scrape HTML.

When runhub creates a run worktree it does not write the project's shared `.git/config` or `--global`. Commit author comes from `RUNHUB_GIT_NAME` / `RUNHUB_GIT_EMAIL`, else `~/.config/runhub/identity.toml` (`name` and `email`). Copy `identity.toml.example`, `chmod 600` the file, and keep only author metadata there. No PATs, SSH keys, or other secrets. If both env and file are missing, `runhub run` exits before the agent starts and the error names that path. The worktree gets `config.worktree` plus `GIT_AUTHOR_*` / `GIT_COMMITTER_*` on the commit and the agent child.

Logs live in `~/.local/share/runhub/runs/`. Each run directory is mode 0700. `prompt.txt`, `spec.txt`, `review-prompt.txt`, and `report.md` are plaintext. Anyone who can read that tree can read the prompts. Finished runs prune older local runs down to 30. `prune --keep N` still deletes the run dir, the worktree, and the local `runhub/<runId>` branch. It never deletes the remote branch or the PR.

Run `npm run contract` before every tag and after upgrading `cursor-agent`, `claude`, or `gh`. That hits the real binaries, not the fake ones in `npm test`.

Optional flags: `--timeout 30m` (already the default), `--test-cmd "npm test"`, `--agent`, `--model`, `--review`, `--prompt-file`, `--no-preamble`. `wait` also takes `--timeout`.

Paste `GROKBOT.md` into Grok as a custom instruction.

## Cursor MCP

`runhub-mcp` is a local stdio MCP server. It calls the same code as `runhub run`, `wait`, `list`, `status`, `report`, and `inspect`. `--cwd` still has to be a name or path from `projects.toml`. There is no `merge` tool.

Start it with `runhub-mcp` after a global install, or `node dist/mcp.js` from this repo.

Tool names: `run`, `wait`, `list`, `status`, `report`, `inspect`.

Cursor reads `~/.cursor/mcp.json`. One-line shape: `{"mcpServers":{"runhub":{"command":"runhub-mcp"}}}`. Expanded:

```json
{
  "mcpServers": {
    "runhub": {
      "command": "runhub-mcp"
    }
  }
}
```

## If you are sharing this

The public repo is https://github.com/0jrm/runhub
