# Config

All user config lives under `~/.config/runhub/` (or `$XDG_CONFIG_HOME/runhub/`). Run data lives under `~/.local/share/runhub/runs/`.

## projects.toml

Allow-list of repos runhub may touch. Every `runhub run --cwd` must resolve to one of these.

```toml
[hycom]
path = "/home/you/hycom"
remote = "origin"
test = "npm test"
typecheck = "npm run typecheck"
lint = "npm run lint"
preamble = "/home/you/.config/runhub/hycom-preamble.md"
```

| Key | Required | Meaning |
| --- | --- | --- |
| `path` | yes | Absolute path to the git repo |
| `remote` | no | Git remote name; when set, push + open a PR (if `gh` is authed) |
| `test` / `typecheck` / `lint` | no | Override auto-detection |
| `preamble` | no | File that replaces the built-in unattended instructions |

`--cwd` accepts the table name (`hycom`) or that path. Unknown paths exit 2 with `not in projects.toml: …`.

Global preamble override (if non-empty): `~/.config/runhub/preamble.md`. Project `preamble` wins. `--no-preamble` writes the spec alone (debug).

## identity.toml

Author metadata for commits runhub makes in the worktree. **Not** secrets — no PATs, SSH keys, or tokens.

```toml
# ~/.config/runhub/identity.toml  (chmod 600)
name = "Testy the bot"
email = "112202668+0jrm@users.noreply.github.com"
```

Resolution order:

1. `RUNHUB_GIT_NAME` / `RUNHUB_GIT_EMAIL` (non-empty env)
2. `name` / `email` in `identity.toml`

If either name or email is still missing, runhub fails fast and prints the expected toml path. There is no silent `runhub@localhost` fallback.

How it is applied:

- Written only to that worktree’s `config.worktree` via `git config --file …`
- Also passed as `GIT_AUTHOR_*` / `GIT_COMMITTER_*` to the commit and the agent child
- Never touches the shared `.git/config` or `git config --global`

Copy from [`identity.toml.example`](identity.toml.example) in the repo.

## Cursor MCP (`runhub-mcp`)

Hand-rolled stdio JSON-RPC server (no MCP SDK; this package has no runtime dependencies). Tool names are unprefixed because the server is already named `runhub`:

`run` · `wait` · `list` · `status` · `report` · `inspect`

There is no `merge` tool.

```json
{
  "mcpServers": {
    "runhub": {
      "command": "runhub-mcp"
    }
  }
}
```

Notes that matter at the keyboard:

- MCP `run` rejects `prompt: "-"` — stdin is the JSON-RPC pipe, not a spec source. Pass `prompt` or `prompt_file`.
- MCP `inspect` is a one-shot snapshot (no follow). CLI `runhub inspect -f` follows log bytes until the pipeline PID exits; `--json` never follows.

## inspect defaults

`runhub inspect` with no extra flags:

- picks the latest running run, else the most recent
- tails **all** log kinds
- **20** lines (same window as the stderr snippet in `report.md`)

```bash
runhub inspect
runhub inspect <runId> -n 50 --tail agent
runhub inspect <runId> -f          # until pipeline PID dies
runhub inspect <runId> --json      # snapshot once, no follow
runhub inspect <runId> --links-only
```

## Logs and privacy

Each run directory under `~/.local/share/runhub/runs/<runId>/` is mode `0700`. `prompt.txt`, `spec.txt`, and `report.md` are plaintext — anyone who can read that tree can read the prompts. Finished runs prune older local runs down to 30; `prune --keep N` deletes the local run dir, worktree, and local branch, never the remote branch or PR.
