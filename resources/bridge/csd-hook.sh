#!/bin/sh
# Claude Session Dashboard: hook bridge for session alerts (installed by the app).
#
# Claude Code runs this for a few hook events (Notification, Stop,
# UserPromptSubmit, SessionStart/End, ...) and pipes the event's JSON to it.
# It saves the payload atomically as events/<session>.<event>.json, where the
# dashboard reads it, and nothing else: it prints nothing (some events would
# add printed text to Claude's context) and always exits 0.
# POSIX sh and awk only: no jq, node or python needed.

exec 2>/dev/null
DIR="${CSD_BRIDGE_DIR:-$HOME/.claude-session-dashboard}"
EVENTS="$DIR/events"
MAX=1048576

input=$(cat)
[ -n "$input" ] || exit 0
# Bounded: a payload this big isn't saved (the dashboard wouldn't read it either).
[ "${#input}" -le "$MAX" ] || exit 0

# The two fields that name the file, read from the top level of the JSON
# only: the same names inside tool input or a message never count.
ids=$(printf '%s' "$input" | LC_ALL=C awk '
BEGIN { RS = "\001" }
{
  s = $0; n = length(s); depth = 0; want = ""; i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      j = i + 1; str = ""
      while (j <= n) {
        d = substr(s, j, 1)
        if (d == "\\") { str = str d substr(s, j + 1, 1); j += 2; continue }
        if (d == "\"") break
        str = str d; j++
      }
      if (depth == 1) {
        if (want != "") {
          if (want == "session_id" && sid == "") sid = str
          if (want == "hook_event_name" && ev == "") ev = str
          want = ""
        } else {
          k = j + 1
          while (k <= n && substr(s, k, 1) ~ /[ \t\r\n]/) k++
          if (substr(s, k, 1) == ":") { want = str; j = k }
        }
      }
      i = j + 1
      continue
    }
    if (c == "{" || c == "[") { if (depth == 1) want = ""; depth++ }
    else if (c == "}" || c == "]") depth--
    else if (depth == 1 && c !~ /[ \t\r\n,:]/) want = ""
    i++
  }
  printf "%s %s\n", sid, ev
}')
sid=${ids% *}
ev=${ids#* }
case "$sid" in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
case "$ev" in '' | *[!A-Za-z]*) exit 0 ;; esac
[ ${#sid} -le 128 ] && [ ${#ev} -le 40 ] || exit 0

mkdir -p "$EVENTS" || exit 0
name="$sid.$ev.json"
tmp="$EVENTS/.tmp.$$.$name"
printf '%s\n' "$input" > "$tmp" && mv -f "$tmp" "$EVENTS/$name" || rm -f "$tmp"
exit 0
