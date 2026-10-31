#!/bin/sh
# Claude Session Dashboard: hook bridge for session alerts (installed by the app).
#
# Claude Code runs this for a few hook events (Notification, Stop,
# UserPromptSubmit, SessionStart/End, ...) and pipes the event's JSON to it.
# It saves the payload atomically as events/<session>.<event>.json, where the
# dashboard reads it, and nothing else: it prints nothing (some events would
# add printed text to Claude's context) and always exits 0.
# POSIX sh only: no jq, node or python needed.

exec 2>/dev/null
DIR="${CSD_BRIDGE_DIR:-$HOME/.claude-session-dashboard}"
EVENTS="$DIR/events"

input=$(cat)
[ -n "$input" ] || exit 0

flat=$(printf '%s' "$input" | tr -d '\n')
# Only the two fields that name the file; both must be plain identifiers.
sid=$(printf '%s' "$flat" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p')
ev=$(printf '%s' "$flat" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p')
[ -n "$sid" ] && [ -n "$ev" ] || exit 0
[ ${#sid} -le 128 ] && [ ${#ev} -le 40 ] || exit 0

mkdir -p "$EVENTS" || exit 0
name="$sid.$ev.json"
tmp="$EVENTS/.tmp.$$.$name"
printf '%s\n' "$input" > "$tmp" && mv -f "$tmp" "$EVENTS/$name" || rm -f "$tmp"
exit 0
