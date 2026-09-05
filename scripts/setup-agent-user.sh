#!/bin/sh
# Idempotent. Run once with sudo.
# Creates runhub-agent, group runhub, data-root perms, copies Cursor/Claude
# auth into /home/runhub-agent, and prints the sudoers line. Does not write
# /etc/sudoers.d/runhub-agent unless you confirm on a tty.

set -eu

HOST_USER=jrm22n
AGENT_USER=runhub-agent
AGENT_GROUP=runhub
AGENT_HOME=/home/runhub-agent
HOST_HOME=$(getent passwd "$HOST_USER" | cut -d: -f6)
if [ -z "$HOST_HOME" ]; then
  echo "no passwd entry for $HOST_USER" >&2
  exit 1
fi
DATA_ROOT="$HOST_HOME/.local/share/runhub"
ENV_BIN=$(command -v env)
if [ -z "$ENV_BIN" ]; then
  ENV_BIN=/usr/bin/env
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0" >&2
  exit 1
fi

if ! getent passwd "$AGENT_USER" >/dev/null; then
  useradd --system --create-home --home "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"
  echo "created user $AGENT_USER"
else
  echo "user $AGENT_USER already exists"
fi

if ! getent group "$AGENT_GROUP" >/dev/null; then
  groupadd "$AGENT_GROUP"
  echo "created group $AGENT_GROUP"
else
  echo "group $AGENT_GROUP already exists"
fi

usermod -aG "$AGENT_GROUP" "$HOST_USER"
usermod -aG "$AGENT_GROUP" "$AGENT_USER"
echo "added $HOST_USER and $AGENT_USER to $AGENT_GROUP"

mkdir -p "$DATA_ROOT/runs"
chown "$HOST_USER:$AGENT_GROUP" "$DATA_ROOT" "$DATA_ROOT/runs"
chmod 2770 "$DATA_ROOT" "$DATA_ROOT/runs"
echo "data root $DATA_ROOT owner $HOST_USER:$AGENT_GROUP mode 2770"

resolve_as_host() {
  sudo -u "$HOST_USER" -H env PATH="$HOST_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" command -v "$1" || true
}

CURSOR_BIN=$(resolve_as_host cursor-agent)
if [ -z "$CURSOR_BIN" ]; then
  CURSOR_BIN=$(resolve_as_host agent)
fi
CLAUDE_BIN=$(resolve_as_host claude)

grant_traverse() {
  path=$1
  while [ "$path" != "/" ] && [ -n "$path" ]; do
    setfacl -m "u:${AGENT_USER}:--x" "$path" 2>/dev/null || true
    path=$(dirname "$path")
  done
}

grant_exec() {
  bin=$1
  if [ -z "$bin" ] || [ ! -e "$bin" ]; then
    return 0
  fi
  real=$(readlink -f "$bin")
  grant_traverse "$(dirname "$real")"
  grant_traverse "$(dirname "$bin")"
  setfacl -m "u:${AGENT_USER}:r-x" "$real" 2>/dev/null || true
  setfacl -m "u:${AGENT_USER}:r-x" "$bin" 2>/dev/null || true
  verdir=$(dirname "$real")
  setfacl -R -m "u:${AGENT_USER}:r-x" "$verdir" 2>/dev/null || true
  echo "acl r-x for $AGENT_USER on $real"
}

grant_exec "$CURSOR_BIN"
grant_exec "$CLAUDE_BIN"

copy_auth() {
  src=$1
  dest=$2
  if [ ! -e "$src" ]; then
    echo "skip missing $src"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
  chown -R "$AGENT_USER:$AGENT_USER" "$dest"
  echo "copied $src -> $dest"
}

echo "copying Cursor and Claude auth (never .ssh, .config/gh, .git-credentials):"
copy_auth "$HOST_HOME/.config/cursor/auth.json" "$AGENT_HOME/.config/cursor/auth.json"
copy_auth "$HOST_HOME/.claude/.credentials.json" "$AGENT_HOME/.claude/.credentials.json"
copy_auth "$HOST_HOME/.claude/settings.json" "$AGENT_HOME/.claude/settings.json"
chown "$AGENT_USER:$AGENT_USER" "$AGENT_HOME"
chmod 755 "$AGENT_HOME"

sudoers_cmd() {
  bin=$1
  if [ -z "$bin" ]; then
    return 0
  fi
  printf '%s -i HOME=%s PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm %s *' "$ENV_BIN" "$AGENT_HOME" "$bin"
}

LINE="$HOST_USER ALL=($AGENT_USER) NOPASSWD:"
FIRST=1
for bin in "$CURSOR_BIN" "$CLAUDE_BIN"; do
  if [ -z "$bin" ]; then
    continue
  fi
  cmd=$(sudoers_cmd "$bin")
  if [ "$FIRST" -eq 1 ]; then
    LINE="$LINE $cmd"
    FIRST=0
  else
    LINE="$LINE, $cmd"
  fi
done

echo "sudoers line (argv-exact, NOPASSWD, nothing else):"
echo "$LINE"

SUDOERS=/etc/sudoers.d/runhub-agent
if [ ! -t 0 ]; then
  echo "stdin is not a tty; not writing $SUDOERS"
  exit 0
fi

printf "write that line to %s? [y/N] " "$SUDOERS"
read -r ans
if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
  echo "not writing $SUDOERS"
  exit 0
fi

tmp=$(mktemp)
echo "$LINE" >"$tmp"
chmod 440 "$tmp"
if visudo -c -f "$tmp"; then
  cp "$tmp" "$SUDOERS"
  chmod 440 "$SUDOERS"
  echo "wrote $SUDOERS"
else
  echo "visudo rejected the line; not installing" >&2
  rm -f "$tmp"
  exit 1
fi
rm -f "$tmp"
