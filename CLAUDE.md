# Claude Session Dashboard — Build Spec

A Windows desktop app that collects every Claude Code session from Windows **and** WSL, shows them in a readable form, lets me name and describe each one, and resumes any session in a terminal with full context.

This repo is built in a Claude Code cloud session (Linux). The app runs on **Windows 10/11**. Write the code so it works on Windows, and test the platform-specific parts with fixtures and mocks.

---

## Hard rules (safety)

1. **The app never deletes or modifies anything** under any `.claude` directory. It only reads, plus one exception: restoring an archived session file that is *missing* (see Archive). It must never overwrite an existing file.
2. The app keeps its own data (archive, metadata) in `%APPDATA%\ClaudeSessionDashboard\` only.
3. The app has no "delete session" feature. "Hide" is fine (it's a metadata flag only).
4. No network calls. Everything stays local.

**Phase 5 (usage, limits, API credits, model tracking):** see [`docs/PHASE-5-USAGE-TRACKING.md`](docs/PHASE-5-USAGE-TRACKING.md). It adds two narrow, opt-in exceptions to the rules above, each allowed only after I explicitly approve it in the app: (a) editing the `statusLine` key in Claude's `settings.json` (backup first, change nothing else, with an undo that restores the previous value exactly), and (b) read-only reporting calls to `https://api.anthropic.com` once I've added an API key.

**Session alerts (hook bridge, extends Phase 5 exception (a)):** "Running now" reads `~/.claude/sessions/*.json` read-only. When I click **Enable session alerts** for an environment (and confirm the exact diff), the app may also change the `hooks` key of that environment's `settings.json`, with the same safety model as the status line bridge: back up first; **append** one hook group per event (Notification, PermissionRequest, Stop, StopFailure, SubagentStop, UserPromptSubmit, SessionStart, SessionEnd) at the end of each event's list, never replacing, reordering or reformatting existing hooks; change nothing else; and Disable takes out exactly the app's handlers: only handlers running exactly the command the app wrote count as its own (a wrapper of mine that mentions the script stays), and only their text is removed, so every other byte (other hooks, formatting, comments) stays; the whole file is restored byte for byte when nothing else changed. A file with comments is handled; one with a duplicate `hooks` key (or event) is refused. Every change to settings.json (session alerts and the status line bridge) is saved the same way: a timestamped backup goes to the app's data folder first; the new content is written to a temp file in the same folder and flushed; right before the swap settings.json is read again and must still be exactly what I reviewed (else nothing changes); then one atomic same-folder rename replaces it, so there is never a moment without settings.json. If that rename isn't possible, nothing is changed. Known limit: a program that already has settings.json open (an editor) can still save over the change afterwards; the backup keeps my reviewed file. At startup the app removes its own leftover temp files and puts a leftover moved-aside file back only if settings.json is missing. The hook script lives in `<home>/.claude-session-dashboard/bin/` and only saves each event to `<home>/.claude-session-dashboard/events/`; the app may prune its own event files there that are older than a week. The script prints nothing, runs async, and always exits 0.

**Phone push alerts (exception #5 to "no network calls"):** opt-in Web Push, **off until I turn it on separately on each phone**. To deliver an alert while the phone app is closed, the PC POSTs an end-to-end encrypted Web Push message (RFC 8291, VAPID) to the push endpoint that phone registered, and only to known browser push services (Google FCM, Apple, Mozilla, Microsoft). Nothing else leaves the PC.
- Push payloads are minimal: only the kind of alert (e.g. "A session needs your approval", "A session finished") plus an opaque random reference, made separately for each phone; it works once, only for that phone, and for a day. **No session names, project names, paths or message text.** When I tap the notification, the phone resolves the reference and loads the details from the PC over Tailscale.
- Revoking a phone, or turning push off on the phone or in Settings → Phone, drops its subscription. The phone shows push as off only after the PC confirms, and shows it as on only when the PC holds that phone's current subscription. A subscription the push service reports gone is dropped too. Sends are logged in the activity log (kind and phone count only, never endpoints).

**Branching ("Branch from here"):** a third narrow exception to rule 1. To branch from a message, the app may **add one new session file** (`<new-uuid>.jsonl`) in the same project folder as the session it branches from, holding the original's lines up to that message with the `sessionId` fields changed. The file is created exclusively (it never overwrites), and nothing existing is ever changed or deleted. The app explains this and asks for confirmation the first time.

**Phone companion (exception #3 to "no network calls"):** local / Tailscale-only network access, opt-in. When I turn on phone access in Settings → Phone, the app runs a small server for its own mobile web app:
- **Off by default.** When on, it listens on `127.0.0.1` only. In Tailscale mode, `tailscale serve` publishes it over HTTPS to my own tailnet. Never Funnel or any other public exposure. Turning it off removes only the app's own serve rule; it never resets or changes any other Tailscale serve config.
- **Optional home Wi-Fi mode:** listens on one private LAN address I pick (self-signed TLS), with one Windows Firewall rule limited to the Private profile and the local subnet. The rule is added only after I confirm, and the app offers to remove it when the mode is turned off.
- **Pairing:** QR code with the URL and a one-time code. Each phone gets its own token (only its hash is stored), can be revoked, and expires after 30 days unused.
- **What a phone can do:** read sessions and usage, edit names/descriptions/tags/pins/hidden, change a safe subset of settings (never security, pairing, API keys, Tailscale or the server itself), and ask the PC to Resume / Fork / Branch a *known* session. Launches use only the fixed resume/fork/branch commands, always with Remote Control on the Claude subscription, never `--dangerously-skip-permissions`, rate-limited, optionally confirmed on the PC, blocked in read-only mode, and logged in an activity log.
- The companion server makes no outgoing calls. Its data lives in `%APPDATA%\ClaudeSessionDashboard\` (`mobile.json`).

**Terminal access over SSH (exception #4: system changes, opt-in):** Settings → Terminal access (SSH) sets up **Windows' own OpenSSH Server** so I can open a real terminal on this PC from my phone, over Tailscale only.
- **Every change is shown first** (the exact PowerShell script), then confirmed, then Windows asks for administrator rights. Inputs reach the script only as base64 data, never as script text. Every change is logged (`terminal.json`) and has an Undo.
- **What it may change, and nothing else:** install/uninstall the OpenSSH Server capability (uninstall only if the wizard installed it); the `sshd` service's start type and state; **one** firewall rule of its own (`CSD-SSH-Tailscale`: sshd.exe, TCP 22, only from `100.64.0.0/10` and `fd7a:115c:a1e0::/48`, on the Tailscale adapter); turning Windows' default "any address" rule (`OpenSSH-Server-In-TCP`) off and back on, only with my OK; the `HKLM\SOFTWARE\OpenSSH\DefaultShell` value (previous value recorded, Undo restores it or removes it); **adding** one line per key to `administrators_authorized_keys` (admins) or `~/.ssh/authorized_keys`; and the global `PasswordAuthentication` line of `sshd_config` (the original is backed up byte for byte in `%APPDATA%\ClaudeSessionDashboard\terminal-backups\` first, and only restored if the file is still what the wizard wrote).
- **Never:** delete or change a key I added myself (Undo removes only the exact line the wizard added), expose SSH outside Tailscale, use Funnel, or touch the router. **"Turn off terminal access"** undoes exactly what the wizard changed.
- **The dashboard never runs commands for the phone.** SSH logins are handled entirely by Windows' OpenSSH. A paired phone can only *read* where to connect (`terminal:phoneInfo`) and *offer* its public key while the PC is waiting for one; the key is added only after I click Allow on the PC and confirm the change like any other.
- "Open terminal here" on the desktop opens a plain local terminal in the session's folder (no Claude), built as an argument array like Resume.

---

## Stack

- **Electron + TypeScript + Vite + React**. Keep it simple.
- **No native Node modules** (no better-sqlite3 and the like), so `npm install` works on Windows without build tools.
  - Metadata: a JSON file written atomically (write to a temp file, then rename).
  - Full-text search: MiniSearch (or similar pure-JS library), index built at startup and updated incrementally.
- Packaging: electron-builder, Windows NSIS installer + portable exe.
- Add a GitHub Actions workflow (`windows-latest`) that runs tests and builds the installer as a downloadable artifact on push to `main`.

---

## Where sessions live

Claude Code stores each session as a JSONL file:
`<home>/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl`

Sources to scan:
- **Windows:** `%USERPROFILE%\.claude\projects\`
- **WSL:** for each distro, `\\wsl.localhost\<distro>\home\<user>\.claude\projects\` for every user folder under `/home`, plus `/root` if readable.
  - List distros with `wsl.exe -l -q`. **Its output is UTF-16LE**, so decode it correctly and strip null bytes and blank lines.
  - Fall back to `\\wsl$\<distro>\...` if `\\wsl.localhost` fails.
  - Skip distros that aren't running or can't be read, without crashing, and show a small notice.
- Settings screen: let me add extra folders to scan.

Each JSONL line is one JSON event. Parse defensively, because the format changes between Claude Code versions:
- Skip lines that fail to parse, and count them.
- Useful fields when present: `type` (`user`, `assistant`, `summary`, …), `message.content` (string or array of blocks: `text`, `tool_use`, `tool_result`, `thinking`), `timestamp`, `cwd`, `sessionId`, `gitBranch`, `version`.
- The **working directory** for resume comes from the `cwd` field of the session's events. Don't decode the folder name for it.
- Watch the source folders (chokidar or fs.watch) so new and updated sessions show up live.

---

## Session list (main screen)

Each row/card shows:
- **My name for the session** (editable). If I haven't named it, show Claude's `summary` if there is one, otherwise the first user message cut short.
- **My description** (editable, multi-line).
- **Start date/time and last-activity date/time**, in local time, e.g. `Oct 22, 2026 2:47 PM`.
- Project folder, environment badge (`Windows` or `WSL: Ubuntu`), git branch, message count.
- Tags (editable).
- An "archived only" badge if the original file is gone from `.claude` and only the app's copy remains.

Controls:
- Sort by last activity (default), start time, or name.
- Filter by project, environment, tag, date range, and hidden/visible.
- A search box that does full-text search across names, descriptions, tags and all message text.

Names, descriptions and tags are stored in the app's metadata file, keyed by session id. **They are never written into Claude's files.**

---

## Session viewer

- Chat-style layout: user and assistant bubbles, timestamps, markdown rendering, code highlighting.
- Tool calls and tool results are collapsed by default ("▸ Edit src/app.ts", "▸ Bash: npm test"). Click to expand. Truncate huge results and add a "show all" button.
- Thinking blocks are collapsed and labeled.
- Find-in-session.
- Name, description and tags can be edited from a header at the top of the viewer.
- **Export to Markdown** button (a save dialog that writes a `.md` file wherever I choose).

---

## Resume (the key feature)

Buttons: **Resume** and **Fork** (Fork adds `--fork-session` so the original stays untouched).

Before launching:
1. If the original `.jsonl` is missing from `.claude/projects/...` but the archive has it, copy it back to its **original path** (recorded in the archive metadata). Only do this if the target doesn't already exist. Never overwrite.
2. Check that the `cwd` still exists. If it doesn't, warn me and let me pick another folder.

Launch commands (prefer Windows Terminal `wt.exe`; fall back to a new `cmd`/PowerShell window if `wt.exe` isn't found):
- **Windows session:**
  `wt.exe -d "<cwd>" cmd /k claude --resume <session-id> [--dangerously-skip-permissions] [--fork-session]`
- **WSL session:**
  `wt.exe wsl.exe -d <distro> --cd "<linux-cwd>" -- bash -lic "claude --resume <session-id> [--dangerously-skip-permissions] [--fork-session]"`
  (`bash -lic` loads the login shell so `claude` is on PATH, e.g. when it's installed via nvm.)

Build commands as argument arrays (`child_process.spawn` with `detached: true`), not by joining strings, so paths with spaces work.

**`--dangerously-skip-permissions`**: **on by default.** Add a Settings toggle and a per-launch checkbox. When it's on, show a small warning label: "Claude will not ask before running commands or deleting files."

Also add "Copy resume command" so I can paste it myself.

---

## Archive (keep sessions forever)

Claude Code deletes session files older than its `cleanupPeriodDays` setting (30 days by default). To keep everything:
- On startup and whenever a file changes, **copy** each session `.jsonl` into `%APPDATA%\ClaudeSessionDashboard\archive\<source-id>\<session-id>.jsonl`. Re-copy when the source has grown.
- Record source environment, original absolute path, cwd and hashes in the metadata.
- Never remove anything from the archive automatically.
- Settings shows archive size and the archive folder location (with an "Open folder" button).
- Settings shows the current `cleanupPeriodDays` (read-only) with a note on how to raise it. **Don't edit Claude's settings files.**

---

## Settings screen

- Scan sources (auto-detected plus manual additions), each with a status.
- Default for `--dangerously-skip-permissions`.
- Terminal preference: Windows Terminal, PowerShell, or cmd.
- Theme: light, dark, or system.

---

## Testing (in the cloud environment)

- Unit tests (Vitest) for: JSONL parsing (including malformed lines and old/new formats), title fallback logic, decoding the WSL distro list (UTF-16LE fixture), building launch commands (Windows and WSL, paths with spaces), and restore-never-overwrites.
- Put realistic sample session files in `fixtures/`.
- The Electron UI should run on Linux with fixtures (`npm run dev -- --fixtures`) for a smoke test.

---

## Deliverables

- Working app source, `README.md` with install/run/build steps for Windows, the GitHub Actions workflow, and tests passing.
- Commit in small, clear steps, then push.
