#!/bin/sh
# Claude Session Dashboard: status line bridge (installed by the app).
#
# Claude Code pipes a JSON payload to the status line command on every update.
# This script saves it (atomically) for the dashboard, then either passes it
# to your previous status line command or prints a short line itself.
# POSIX sh only: no jq, node or python needed. Never fails loudly.

exec 2>/dev/null
DIR="${CSD_BRIDGE_DIR:-$HOME/.claude-session-dashboard}"
LIVE="$DIR/live"

input=$(cat)
[ -n "$input" ] || exit 0

mkdir -p "$LIVE" || exit 0

save() {
  tmp="$LIVE/.tmp.$$.$1"
  printf '%s\n' "$input" > "$tmp" && mv -f "$tmp" "$LIVE/$1" || rm -f "$tmp"
}

# The session id is used as a file name, so only accept safe characters.
sid=$(printf '%s' "$input" | tr -d '\n' | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p')
[ -n "$sid" ] && save "$sid.json"
save latest.json

# Chain to the status line command you had before (saved by the app).
if [ -s "$DIR/chain.sh" ]; then
  printf '%s\n' "$input" | sh "$DIR/chain.sh"
  exit 0
fi

flat=$(printf '%s' "$input" | tr -d '\n')
field() {
  printf '%s' "$flat" | sed -n "s/.*$1.*/\\${2:-1}/p"
}
num='[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\)'
model=$(field '"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)"')
five=$(field "\"five_hour\"[[:space:]]*:[[:space:]]*{[^}]*\"used_percentage\"$num")
week=$(field "\"seven_day\"[[:space:]]*:[[:space:]]*{[^}]*\"used_percentage\"$num")
# context_window holds a nested current_usage object, so allow one level of braces.
ctx=$(field "\"context_window\"[[:space:]]*:[[:space:]]*{\\([^{}]*{[^{}]*}\\)*[^{}]*\"used_percentage\"$num" 2)

line="${model:-Claude}"
[ -n "$five" ] && line="$line · 5h ${five%%.*}%"
[ -n "$week" ] && line="$line · week ${week%%.*}%"
[ -n "$ctx" ] && line="$line · ctx ${ctx%%.*}%"
printf '%s\n' "$line"
exit 0
