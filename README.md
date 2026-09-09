# runhub

One command on your laptop starts a coding agent in an isolated git worktree, checks the diff, runs tests, optionally asks Claude to review, and leaves you a short report.

You talk to Grok on your phone. Grok runs `runhub`. The laptop does the rest.

## Install

Node 20+.

```bash
git clone https://github.com/0jrm/runhub.git
cd runhub
npm install
npm run build
npm install -g .
```

## First run

1. Register a project in `~/.config/runhub/projects.toml` (see [CONFIG.md](CONFIG.md)).
2. Set commit author in `~/.config/runhub/identity.toml` (copy from [`identity.toml.example`](identity.toml.example)).
3. Start a run, then wait for the report:

```bash
runhub run --cwd hycom --prompt "fix the login bug"
# prints: runhub: <runId>
runhub wait <runId>
```

More detail: [QUICKSTART.md](QUICKSTART.md).

## Everyday commands

| Command | What it does |
| --- | --- |
| `runhub run --cwd <name> --prompt "…"` | Start a background pipeline; returns a run id in ~2s |
| `runhub wait <runId>` | Block until the report is ready (default 10m) |
| `runhub status [runId]` | Snapshot of one run |
| `runhub report [runId]` | Print the stored report |
| `runhub list` | Recent runs |
| `runhub inspect [runId]` | Session links + log tails |
| `runhub merge <runId>` | Squash-merge the PR, or merge the branch locally |
| `runhub prune --keep 20` | Drop old local runs |

Useful `run` flags: `--agent cursor|claude`, `--review claude`, `--model <id>`, `--prompt-file <path>`, `--prompt -` (stdin), `--test-cmd`, `--timeout`, `--no-preamble`.

`--cwd` must be a table name or path listed in `projects.toml`. Anything else exits 2.

## Outcomes (honest)

- **pass** — non-empty diff and a test command exited 0
- **changed, untested** — files changed, but no usable test command (or base already failing)
- **no-changes** — empty diff
- **fail** — agent error/timeout, or test/typecheck/lint failed after a clean base

A `blocked:` line means the agent stopped on an irreversible choice. It does not flip pass/fail by itself.

## Cursor MCP

Same tools as the CLI (no `merge`): `run`, `wait`, `list`, `status`, `report`, `inspect`.

```json
{
  "mcpServers": {
    "runhub": {
      "command": "runhub-mcp"
    }
  }
}
```

Put that in `~/.cursor/mcp.json`. Or run `node dist/mcp.js` from this repo. Details in [CONFIG.md](CONFIG.md).

## Phone / Grok

Paste [`GROKBOT.md`](GROKBOT.md) into Grok as a custom instruction.

## Dig deeper

- [QUICKSTART.md](QUICKSTART.md) — install → first green report
- [CONFIG.md](CONFIG.md) — `projects.toml`, `identity.toml`, MCP, logs
- [ASSUMPTIONS.md](ASSUMPTIONS.md) — intentional product choices
- [CONTRACT.md](CONTRACT.md) / `npm run contract` — real-binary checks before a tag
- [SANDBOX.md](SANDBOX.md) — optional dedicated agent user

Public repo: https://github.com/0jrm/runhub
