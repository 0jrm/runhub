ASSUMED: MCP is a hand-rolled stdio JSON-RPC server with no SDK because this package has no runtime dependencies.
ASSUMED: MCP tool names are run, run_and_wait, wait, list, status, report, inspect (unprefixed) because the server is already named runhub.
ASSUMED: MCP run rejects prompt "-" because stdin is the JSON-RPC pipe, not a spec source.
ASSUMED: inspect --follow exits when the pipeline PID dies, and --json never follows, because a hanging MCP inspect would be unusable.
ASSUMED: git identity is RUNHUB_GIT_NAME/EMAIL then ~/.config/runhub/identity.toml, written only to the worktree config.worktree and GIT_AUTHOR_*/GIT_COMMITTER_* on the commit and agent, never shared .git/config or --global. Missing identity fails fast (no runhub@localhost fallback) and suggests `runhub init --identity`. Leftover runhub@localhost may exist in old local .git/config only.
ASSUMED: default inspect tail is all logs, 20 lines, because that matches report.md's stderr window.
ASSUMED: inspect --tail verify prefers verify.out, then the recorded test tail, then pipeline.log, because verify.out is the live verify stream.
ASSUMED: `runhub init` never prompts; `--yes` marks the noninteractive path and copies identity.toml.example when identity.toml is missing.
ASSUMED: `runhub doctor` lists git, gh, cursor-agent, and claude, and exits 1 only when git is missing, because gh and claude are optional.
ASSUMED: `runhub add` uses the directory basename as the projects.toml table name, quoted path, idempotent on the same path.
ASSUMED: CLI `run` waits by default; `--detach` is the old async print-id-and-return; a waiting run uses max(10m, agent timeout + 1m).
ASSUMED: MCP `run` stays fire-and-forget like `--detach`; `run_and_wait` waits; still no merge tool.
ASSUMED: GROKBOT keeps `--detach` then `wait --timeout 90s` because a phone bot should not block for the full agent timeout.
ASSUMED: this worktree does not push or open a PR; the runhub pipeline owns remotes.
