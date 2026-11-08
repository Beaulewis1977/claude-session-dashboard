#!/bin/sh
# Claude Session Dashboard: Codex hook for session alerts (installed by the app).
#
# Codex runs this when a session is about to ask for approval
# (PermissionRequest) and pipes the event's JSON to it. It saves only the
# session id, the event name and the tool's name, atomically, as
# codex-events/<session>.<event>.json, where the dashboard reads it. Nothing
# else: no command text or tool input is kept. It prints nothing (so it never
# answers the approval: Codex asks you as usual) and always exits 0.
# POSIX sh and awk only: no jq, node or python needed.

exec 2>/dev/null
DIR="${CSD_BRIDGE_DIR:-$HOME/.claude-session-dashboard}"
EVENTS="$DIR/codex-events"
MAX=4194304

input=$(cat)
[ -n "$input" ] || exit 0
[ "${#input}" -le "$MAX" ] || exit 0

# The three fields, read from the top level of the JSON only: the same
# names inside tool input never count.
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
          if (want == "tool_name" && tool == "") tool = str
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
  printf "%s %s %s\n", sid, ev, tool
}')
sid=${ids%% *}
rest=${ids#* }
ev=${rest%% *}
tool=${rest#* }
case "$sid" in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
case "$ev" in '' | *[!A-Za-z]*) exit 0 ;; esac
[ ${#sid} -le 128 ] && [ ${#ev} -le 40 ] || exit 0
case "$tool" in '' | *[!A-Za-z0-9_.:-]*) tool="" ;; esac
[ ${#tool} -le 100 ] || tool=""

mkdir -p "$EVENTS" || exit 0
name="$sid.$ev.json"
tmp="$EVENTS/.tmp.$$.$name"
if [ -n "$tool" ]; then
  json="{\"session_id\":\"$sid\",\"hook_event_name\":\"$ev\",\"tool_name\":\"$tool\"}"
else
  json="{\"session_id\":\"$sid\",\"hook_event_name\":\"$ev\"}"
fi
printf '%s\n' "$json" > "$tmp" && mv -f "$tmp" "$EVENTS/$name" || rm -f "$tmp"
exit 0
