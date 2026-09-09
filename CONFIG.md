# Config

All user config lives under `~/.config/runhub/` (or `$XDG_CONFIG_HOME/runhub/`). Run data lives under `~/.local/share/runhub/runs/`.

`runhub init` creates the config dir. `runhub add <path>` writes `projects.toml`.

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

`--cwd` accepts the table name (`hycom`) or that path. Unknown paths exit 2 with `not in projects.toml: …`. `runhub add` uses the directory basename as the table name.

Global preamble override (if non-empty): `~/.config/runhub/preamble.md`. Project `preamble` wins. `--no-preamble` writes the spec alone (debug).

## identity.toml

Author metadata for commits runhub makes in the worktree. Not secrets. No PATs, SSH keys, or tokens.

```toml
# ~/.config/runhub/identity.toml  (chmod 600)
name = "Testy the bot"
email = "testy@users.noreply.github.com"
```

Resolution order:

1. `RUNHUB_GIT_NAME` / `RUNHUB_GIT_EMAIL` (non-empty env)
2. `name` / `email` in `identity.toml`

If either name or email is still missing, runhub fails fast, prints the expected toml path, and suggests `runhub init --identity`. There is no silent `runhub@localhost` fallback. Leftover `runhub@localhost` may still appear in an old local `.git/config` from before identity.toml — that is leftover, not how new runs resolve identity.

How it is applied:

- Written only to that worktree's `config.worktree` via `git config --file …`
- Also passed as `GIT_AUTHOR_*` / `GIT_COMMITTER_*` to the commit and the agent child
- Never touches the shared `.git/config` or `git config --global`

Copy from [`identity.toml.example`](identity.toml.example) in the package, or run `runhub init --identity`.

## Cursor MCP (`runhub-mcp`)

Hand-rolled stdio JSON-RPC server (no MCP SDK; this package has no runtime dependencies). Tool names are unprefixed because the server is already named `runhub`:

`run` · `run_and_wait` · `wait` · `list` · `status` · `report` · `inspect`

There is no `merge` tool. `run` matches `runhub run --detach`. `run_and_wait` matches waiting `runhub run`.

```json
{
  "mcpServers": {
    "runhub": {
      "command": "runhub-mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add -s user -t stdio runhub -- runhub-mcp
```

### Claude phone door

The door is a `claude remote-control` session restricted to the six MCP tools. Setup:

```bash
./scripts/setup-door.sh
```

This creates `~/runhub-door/` with a CLAUDE.md skill and a `.claude/settings.json` deny-list (no Bash, no Read, no Monitor), installs a systemd user service, and starts the door. The URL changes on each restart and is written to `~/runhub-door/current-url.txt`. A desktop notification fires when the door comes up.

Manual start (if you prefer not to use systemd):

```bash
cd ~/runhub-door && claude remote-control --name runhub-door --spawn same-dir --capacity 2 --permission-mode default
```

Useful commands:

```bash
systemctl --user status runhub-door.service
systemctl --user restart runhub-door.service
journalctl --user -u runhub-door.service -f
cat ~/runhub-door/current-url.txt
```

Notes that matter at the keyboard:

- MCP `run` rejects `prompt: "-"` — stdin is the JSON-RPC pipe, not a spec source. Pass `prompt` or `prompt_file`.
- MCP `inspect` is a one-shot snapshot (no follow). CLI `runhub inspect -f` follows log bytes until the pipeline PID exits; `--json` never follows.

## inspect defaults

`runhub inspect` with no extra flags:

- picks the latest running run, else the most recent
- tails all log kinds
- 20 lines (same window as the stderr snippet in `report.md`)

```bash
runhub inspect
runhub inspect <runId> -n 50 --tail agent
runhub inspect <runId> -f          # until pipeline PID dies
runhub inspect <runId> --json      # snapshot once, no follow
runhub inspect <runId> --links-only
```

## Logs and privacy

Each run directory under `~/.local/share/runhub/runs/<runId>/` is mode `0700`. `prompt.txt`, `spec.txt`, and `report.md` are plaintext. Anyone who can read that tree can read the prompts. Finished runs prune older local runs down to 30; `prune --keep N` deletes the local run dir, worktree, and local branch, never the remote branch or PR.
