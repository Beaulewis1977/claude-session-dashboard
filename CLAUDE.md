# Claude Session Dashboard — Build Spec

A Windows desktop app that collects every Claude Code session from Windows **and** WSL, shows them in a readable form, lets me name and describe each one, and resumes any session in a terminal with full context.

This repo is built in a Claude Code cloud session (Linux). The app runs on **Windows 10/11**. Write the code so it works on Windows, and test the platform-specific parts with fixtures and mocks.

---

## Hard rules (safety)

1. **The app never deletes or modifies anything** under any `.claude` directory. It only reads, plus one exception: restoring an archived session file that is *missing* (see Archive). It must never overwrite an existing file.
2. The app keeps its own data (archive, metadata) in `%APPDATA%\ClaudeSessionDashboard\` only.
3. The app has no "delete session" feature. "Hide" is fine (it's a metadata flag only).
4. No network calls. Everything stays local.

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
