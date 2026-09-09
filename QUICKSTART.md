# Quickstart

Three commands from a global install.

## 1. Init

```bash
runhub init --yes
```

Creates `~/.config/runhub/` and copies `identity.toml.example` to `identity.toml` if that file is missing (`chmod 600`). Edit `name` and `email`. `--yes` is noninteractive. `runhub doctor` checks git, gh, cursor-agent, and claude. `runhub init --identity` only touches the identity file.

You need `git`, and either `cursor-agent` or `claude` on PATH (depending on `--agent`). Optional: `gh` for opening PRs.

## 2. Add a project

```bash
runhub add /home/you/hycom
```

That appends a table named after the directory basename to `projects.toml`. `--cwd hycom` (the table name) or the absolute path both work. Paths outside this file are refused.

## 3. Run

```bash
runhub run --cwd hycom --prompt "add a one-line comment in README explaining the install step"
```

`run` waits and prints `runhub: <runId>` then the report. Exit 0 on pass / changed-untested / no-changes. Exit 1 on fail. Exit 3 means still running. `--detach` returns after the id only; then `runhub wait <runId>`.

Read it again later with `runhub report <runId>`, or peek at live logs with `runhub inspect <runId> -f`.

Optional: `--review claude`, then `runhub merge <runId>` only when you mean it. Cursor MCP tools match the CLI except there is no `merge` tool. See [CONFIG.md](CONFIG.md).

## Stuck?

| Symptom | Likely fix |
| --- | --- |
| `not in projects.toml: …` | `runhub add <path>` |
| `missing git identity …` | `runhub init --identity` or set the env vars |
| `still running` (exit 3) | Wait longer or `runhub inspect <id> -f` |
| `changed, untested` | Add a `test` key or install the test binary |
