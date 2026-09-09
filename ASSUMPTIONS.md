ASSUMED: MCP is a hand-rolled stdio JSON-RPC server with no SDK because this package has no runtime dependencies.
ASSUMED: MCP tool names are run, wait, list, status, report, inspect (unprefixed) because the server is already named runhub.
ASSUMED: MCP run rejects prompt "-" because stdin is the JSON-RPC pipe, not a spec source.
ASSUMED: inspect --follow exits when the pipeline PID dies, and --json never follows, because a hanging MCP inspect would be unusable.
ASSUMED: git identity is RUNHUB_GIT_NAME/EMAIL then ~/.config/runhub/identity.toml, written only to the worktree config.worktree and GIT_AUTHOR_*/GIT_COMMITTER_* on the commit and agent, never shared .git/config or --global.
ASSUMED: default inspect tail is all logs, 20 lines, because that matches report.md's stderr window.
ASSUMED: inspect --tail verify prefers verify.out, then the recorded test tail, then pipeline.log, because verify.out is the live verify stream.
