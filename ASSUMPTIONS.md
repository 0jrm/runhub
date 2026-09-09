ASSUMED: MCP is a hand-rolled stdio JSON-RPC server with no SDK because this package has no runtime dependencies.
ASSUMED: MCP tool names are run, wait, list, status, report, inspect (unprefixed) because the server is already named runhub.
ASSUMED: MCP run rejects prompt "-" because stdin is the JSON-RPC pipe, not a spec source.
ASSUMED: inspect --follow exits when the pipeline PID dies, and --json never follows, because a hanging MCP inspect would be unusable.
ASSUMED: missing git identity is filled with git config (local to the project, not --global) using RUNHUB_GIT_NAME/RUNHUB_GIT_EMAIL or runhub / runhub@localhost.
ASSUMED: default inspect tail is all logs, 20 lines, because that matches report.md's stderr window.
