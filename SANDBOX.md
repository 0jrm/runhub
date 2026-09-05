# Sandbox

This laptop is Pop!_OS 24.04. The coding agent already runs as `jrm22n` with `--force` or `--dangerously-skip-permissions`. A worktree isolates the git branch. It does not isolate the machine.

What is on this uid today: `~/.ssh`, `~/.config/gh`, Cursor state under `~/.cursor` and `~/.local/share/cursor-agent`, Claude state under `~/.claude`, and `SSH_AUTH_SOCK=/run/user/1000/gcr/ssh`. There is no `~/.aws`. `GH_TOKEN` is unset. `git` has no global credential helper. The gnome-keyring ssh socket is enough. Anyone who can message the Grok bot can start a run. A README in a listed repo that says "also cat ~/.ssh/id_ed25519" is the attack.

Installed now: `bwrap` 0.11.0 from the `bubblewrap` package, `systemd-run`, `unshare`. Missing: `firejail`, `podman`, `docker`. Apt will install firejail 0.9.72, podman 4.9.3, or docker.io 29.1.3.

runhub already pushes after the agent exits. The agent does not need `gh`, `~/.ssh`, or `SSH_AUTH_SOCK`. It does need `git` inside the worktree, the agent CLI, and the LLM network. Tests need the gitignored `node_modules` / `.venv` / `venv` / `target` / `.tox` that runhub already symlinks from the real repo.

None of the three options below is implemented. Pick one.

## a. Dedicated OS user

Create `runhub-agent`. Give it ownership of `~/.local/share/runhub/runs` only, or a dedicated data root. No home copies of `.ssh`, `.aws`, `.config/gh`. runhub stays on `jrm22n` and launches the agent with `sudo -u runhub-agent` plus a tiny env: `PATH`, `HOME` for that user, `TERM`. Drop `SSH_AUTH_SOCK`. Drop `GH_TOKEN`. Drop `GIT_ASKPASS`.

**Reach.** The agent can read and write worktrees it owns. It can talk to the LLM APIs if that user's home holds only Cursor/Claude login files you copied on purpose. It cannot open `jrm22n`'s `~/.ssh`, `~/.config/gh`, or the gnome-keyring ssh socket. File mode 0700 on those dirs already helps a little. A different uid is the thing that still holds if a prompt says `cat /home/jrm22n/.ssh/id_ed25519`.

**Deps and worktree.** Create the worktree as `runhub-agent`, or `chown` it before spawn. The symlink targets `node_modules` and friends must be readable and writable by that user. Easiest: add `runhub-agent` to a group that owns those dirs, or copy instead of symlink. Copying is slow and wastes disk. Group write on `node_modules` is the real cost of this option.

**git push and gh.** Stay in the parent. `sudo -u` is only around `runProcessGroup` for the agent and the reviewer. `pushBranch` and `gh pr create` keep using `jrm22n`'s ssh and gh. The agent never sees those files if HOME and `/run/user/1000` are not shared.

**Breaks.** Agents that shell out to tools only installed in `jrm22n`'s `~/.local/bin` unless you put those binaries in a system path the agent user can execute. `npm` / `hatch` / GPU tools the same way. A project whose `node_modules` is 700 under `jrm22n` will fail tests in the worktree until group perms are fixed. Passwordless sudo for one command is a new hole. Make the sudoers line argv-exact.

**Install.**

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin runhub-agent
sudo mkdir -p /home/runhub-agent/.local/share/runhub
sudo chown -R runhub-agent:runhub-agent /home/runhub-agent
# copy only Cursor/Claude auth into that home, never .ssh or .config/gh
sudo visudo -f /etc/sudoers.d/runhub-agent
```

Sudoers should name the agent binaries, not `/bin/bash`.

## b. bubblewrap or firejail

`bwrap` is already here. firejail is not. Use `bwrap`. firejail's extra profiles are not worth an apt install on a machine that already has bubblewrap.

Sketch, not code:

```text
bwrap --unshare-all --share-net --die-with-parent --new-session \
  --clearenv --setenv HOME /tmp/runhub-home --setenv PATH /usr/bin:/usr/local/bin \
  --dev /dev --proc /proc --tmpfs /tmp \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /home/jrm22n/.local/share/cursor-agent ... \
  --bind <worktree> <worktree> \
  --bind <repo>/node_modules <repo>/node_modules \
  --chdir <worktree> \
  -- cursor-agent ... --force
```

`--share-net` is the per-project network-on flag. Drop it, and the LLM call dies. Keep a project key `network = true|false`. Default true, because both agents need the network today.

**Reach.** With a tight bind list the agent sees the worktree, the dep dirs you mounted, `/usr`, and whatever Cursor/Claude state you mounted. It does not see `~/.ssh` or `~/.config/gh` unless you bind them. Same uid as you. A missed bind of `$HOME` or `/run/user/1000` hands back the ssh socket and every other secret on this account. `/proc` can still leak environment of other processes you accidentally leave visible.

**Deps and worktree.** Bind the worktree read-write. Resolve each dep symlink with `realpath` and bind that target read-write too, or the symlink is a dangling path inside the mount namespace. Do not bind the whole parent repo read-write. That lets the agent edit `main` in place.

**git push and gh.** Do not bind `~/.ssh`, `~/.config/gh`, `/run/user/1000`, or `~/.git-credentials`. `--clearenv` then set only `HOME`, `PATH`, `TERM`, and the vendor vars the agent CLI needs. Parent runhub still pushes after exit, outside bwrap.

**Breaks.** `network = false` breaks every agent that calls an API, and any test that hits the network. Tools that live only under `/home/jrm22n/.local/bin` need an extra `--ro-bind`. Electron/Cursor bits that need `/sys` or a working nsswitch will fail until you bind `/etc` read-only. Binding all of `/etc` includes `/etc/passwd` which is fine, and also any local secrets you parked there which is not. Agents that try to `docker run` or talk to a user systemd session will fail. Nested user namespaces may fail if you pass `--disable-userns`.

**Install.** None for bwrap. Already `/usr/bin/bwrap`. firejail would be `sudo apt install firejail` and then a custom profile. Skip it.

## c. Container

podman is not installed. docker is not installed. Prefer podman if you install either, rootless.

The image needs `git`, `node` 20, the project toolchain, and the agent CLI. Cursor Agent and Claude Code are currently unpacked under this user's `~/.local/share`. There is no public "run this as a daemonless CI image" you can just pull. You would copy those versioned trees into the image or bind them in, plus a writable HOME for their auth files.

**Reach.** The agent sees the container filesystem plus the mounted worktree. It does not see the host home unless you mount it. Rootless podman maps to your uid on the host for bind mounts, so a `--volume /home/jrm22n:...` is as bad as no container. Keep mounts to the worktree, the dep realpaths, and a dedicated HOME volume for agent auth.

**Deps and worktree.** `-v <worktree>:<worktree>:rw` and `-v <repo>/node_modules:...:rw`. Same symlink rule as bwrap. SELinux is not in play on this Pop box.

**git push and gh.** Do not mount ssh or gh. Do not pass `SSH_AUTH_SOCK`. runhub on the host pushes after the container exits.

**Breaks.** First run is an image build, then a several-hundred-megabyte copy of cursor-agent. Agents that expect a full desktop, GPU, or host docker socket will fail unless you pass that socket, which is how you lose the sandbox. Package installs that assume host `/usr` layout will surprise you. Updating cursor-agent on the host will desync the image until you rebuild. Tests that open host ports other than what you published will fail.

**Install.**

```bash
sudo apt install podman
# build an image that pins node 20, git, and a copied cursor-agent/claude tree
```

## Recommendation

Do **a**. The blast radius is this uid's credentials, and `SSH_AUTH_SOCK` already points at a live gnome-keyring. A bind-mount sandbox that still runs as `jrm22n` is one forgotten `--bind $HOME` away from the same agent that exists today. A dedicated user still fails closed when the mount list is wrong. The messy part is `node_modules` group perms and a tight sudoers line. That is cheaper than pretending bwrap is a user boundary.

If you will not create a unix user, do **b** with `--clearenv`, no `/run/user/1000`, no `$HOME`, and `realpath` binds for dep dirs. Do not install firejail or podman until the dedicated user actually hurts.

I would not start with **c**. Nothing is installed, the agent CLIs are not packaged as images, and rootless volumes still use your uid.
