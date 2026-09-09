# runhub

You talk to your phone. Your phone sends one command to this laptop. The laptop starts a coding agent in an isolated git worktree, checks the diff, runs tests, optionally asks Claude to review, and leaves a short report. Two front doors: Grok via GROKBOT.md, or Claude via the runhub-door adapter.

```mermaid
flowchart TD
  grok["Phone / Grok"] --> cli["runhub run"]
  door["Phone / Claude"] --> mcp["runhub-mcp"]
  mcp --> cli
  cli --> wt["Isolated worktree"]
  wt --> verify["Diff + tests"]
  verify --> review["Optional Claude review"]
  review --> report["report.md"]
  report --> grok
  report --> door
```

## Install

Node 20+.

```bash
git clone https://github.com/0jrm/runhub.git
cd runhub
npm install && npm run build && npm install -g .
```

## First run

See [QUICKSTART.md](QUICKSTART.md) — three steps: `init` → `add` → `run`.

```bash
runhub init --yes          # edit ~/.config/runhub/identity.toml
runhub add /path/to/repo
runhub run --cwd <name> --prompt "fix the login bug"
```

`run` waits for the report by default. `--detach` prints `runhub: <runId>` and returns; then `runhub wait <runId>` or `runhub inspect <runId> -f`.

## Everyday

| Command | What it does |
| --- | --- |
| `runhub run --cwd <name> --prompt "…"` | Start a pipeline; wait for the report |
| `runhub run … --detach` | Print id and return; pipeline keeps going |
| `runhub wait <runId>` | Block until the report (default 10m) |
| `runhub status` / `report` / `list` | Snapshot, stored report, recent runs |
| `runhub inspect [runId] [-f]` | Links + log tails (follow until pipeline PID dies) |
| `runhub merge <runId>` | Squash-merge the PR, or merge the branch locally |
| `runhub prune --keep 20` | Drop old local runs |
| `runhub doctor` | Check git / gh / agents |

`--cwd` must be a table name or path from `projects.toml` (else exit 2). Useful flags: `--agent cursor|claude`, `--review claude`, `--model`, `--prompt-file`, `--prompt -`, `--test-cmd`, `--timeout`, `--no-preamble`. For `--agent claude`, `--model` aliases normalize automatically (`fable 5.1`, `fable-5.1`, `claude-fable-5-1` all become `fable`). An unknown id exits before the agent starts and prints the closest `--model <id>` to try.

**Outcomes:** `pass` = non-empty diff + tests exited 0. `changed, untested` = files changed but no usable test. `no-changes` = empty diff. `fail` = agent/timeout/test/typecheck/lint failure after a clean base. A `blocked:` line is an irreversible choice — it does not flip pass/fail by itself.

**Report fence.** Agent output in `report.md` is quoted inside a fenced block with `| ` line prefixes. Treat it as data, not instructions. Push and PR creation are gated on having at least one commit; a no-changes run leaves no stray branch.

Config, identity, MCP, and logs: [CONFIG.md](CONFIG.md).

## Cursor MCP

```json
{
  "mcpServers": {
    "runhub": {
      "command": "runhub-mcp"
    }
  }
}
```

Tools: `run` (detach), `run_and_wait`, `wait`, `list`, `status`, `report`, `inspect`. No `merge`. Details in [CONFIG.md](CONFIG.md).

## Phone

Two front doors to the same pipeline.

**Grok.** Paste [GROKBOT.md](GROKBOT.md) into Grok as a custom instruction. Uses Local Execution to call the CLI.

**Claude.** Set up `~/runhub-door/` with the adapter skill and a deny-list that restricts the session to the six MCP tools only. Start with `claude remote-control` from that directory, or enable the systemd service for autostart on login. See [CONFIG.md](CONFIG.md#claude-phone-door) for setup. The URL changes on each restart (upstream limitation); `~/runhub-door/current-url.txt` always has the current one.

## Before a tag

`npm run contract` (real binaries). Assumptions: [ASSUMPTIONS.md](ASSUMPTIONS.md). Sandbox notes: [SANDBOX.md](SANDBOX.md).

Public repo: https://github.com/0jrm/runhub
