# Quickstart

Get from zero to a finished report.

## 1. Install

```bash
git clone https://github.com/0jrm/runhub.git
cd runhub
npm install && npm run build && npm install -g .
runhub help
```

You need `git`, and either `cursor-agent` or `claude` on PATH (depending on `--agent`). Optional: `gh` for opening PRs.

## 2. Register a project

Create `~/.config/runhub/projects.toml`:

```toml
[hycom]
path = "/home/you/hycom"
remote = "origin"          # optional: push + open a PR
# test = "npm test"        # optional: override auto-detect
```

`--cwd hycom` (the table name) or the absolute path both work. Paths outside this file are refused.

## 3. Set the commit author

runhub never writes your global git config. Copy the example and fill in name + email:

```bash
mkdir -p ~/.config/runhub
cp identity.toml.example ~/.config/runhub/identity.toml
chmod 600 ~/.config/runhub/identity.toml
# edit name + email
```

Or set `RUNHUB_GIT_NAME` / `RUNHUB_GIT_EMAIL` for one shell. If both env and file are missing, `runhub run` exits before starting the agent and names the expected path.

See [CONFIG.md](CONFIG.md) for how identity is applied (worktree-local only).

## 4. Run something small

```bash
runhub run --cwd hycom --prompt "add a one-line comment in README explaining the install step"
```

You should see `runhub: <runId>` within a couple of seconds. The agent keeps working in the background.

## 5. Wait for the report

```bash
runhub wait <runId>
```

Exit 0 on pass / changed-untested / no-changes. Exit 1 on fail. Exit 3 means still running (try again). Default wait timeout is 10 minutes; the run itself keeps going.

Read it again later with `runhub report <runId>`, or peek at live logs with `runhub inspect <runId> -f`.

## 6. Optional: review and merge

```bash
runhub run --cwd hycom --review claude --prompt "fix the flaky timeout in wait"
runhub wait <runId>
runhub merge <runId>    # only when you mean it
```

## 7. Optional: Cursor MCP

Add `runhub-mcp` to `~/.cursor/mcp.json` (see README). Tools mirror the CLI except there is no `merge` tool — merge stays a deliberate human/CLI step.

## Stuck?

| Symptom | Likely fix |
| --- | --- |
| `not in projects.toml: …` | Add the path under a `[name]` table |
| `missing git identity …` | Create `~/.config/runhub/identity.toml` or set the env vars |
| `still running` (exit 3) | Wait longer or `runhub inspect <id> -f` |
| `changed, untested` | Add a `test` key or install the test binary |
