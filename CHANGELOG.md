# Changelog

## Unreleased

- **Backups.** Settings → Backup copies the archive, names, descriptions and tags, usage and limit
  history, and the app's settings to a folder you choose (OneDrive, an external drive, a NAS), daily
  or weekly while the app is open, or with **Back up now**. Only new or changed content is copied
  (content-addressed and compressed), every snapshot has its own manifest, and a snapshot counts only
  once that manifest is written, so an interrupted backup never leaves a broken one. Keeps the last
  14 snapshots by default; retention deletes only the app's own files inside its own backup
  subfolder. API keys are never included. No network calls: your cloud app syncs the folder.
- **Optional password:** scrypt + AES-256-GCM per file, with every file checked on restore. The
  password is never stored; **Remember on this PC** keeps the derived key protected by Windows
  (DPAPI). The app warns that a lost password means unreadable backups.
- **Restore:** pick a snapshot, see what would change, then restore into the app's own data folder
  (never `.claude`). It finishes on restart before any data loads, copies every file it replaces to
  `restore-backups\` first, never deletes a file, never replaces an archived session with a smaller
  copy, and keeps this PC's API keys, phone pairing and window and phone settings. Works across PCs
  and Windows users (archive paths are moved to the new data folder), including on a new PC where
  those files don't exist yet. Restored API accounts show **Key not on this PC**; adding the same
  key again reconnects it, keeping its credits and history.
- **Safety details:** a backup that can't read a file that exists fails instead of making a partial
  snapshot; damaged password details in the backup folder are refused, and a folder that turns
  unencrypted behind the app's back pauses backups until you choose; retention runs under the same
  lock as a backup; a remembered password works again as soon as the drive is back; a newly chosen
  folder gets its first backup right away.
- **One PC per backup folder:** the folder records which PC backs up into it. Another PC can
  restore from it and backs up only after **Take over**. The backup lock is claimed atomically,
  never taken from a backup still running, renewed while it runs, and checked before anything is
  saved or deleted. A folder whose backup set was replaced, or turned unencrypted, outside the app
  pauses backups until you choose (choosing the folder again isn't enough); backup files without
  their `backup-set.json` are never started over; a set folder that is a link is refused; retention
  deletes nothing when the snapshots can't be listed.
- **Reconnect key…** for restored API accounts accepts only the exact key they used (checked by a
  fingerprint of the key, never the key itself), and merges an account you'd already added with
  that key into the restored one, so sessions and credits stay together.
- API keys and the remembered backup password now use Electron's asynchronous `safeStorage` API
  (existing keys keep working).

## 1.5.0 (November 1, 2026)

**Running now: every live Claude Code session at a glance, with alerts on your PC and phone.**

- **Running now.** A new sidebar entry (with a count badge) and a section at the top of the session
  list show every Claude Code session that's running, on Windows and in WSL, with its state:
  Working, Needs approval, Waiting for you, or Exited. Each shows how long it has been running and
  since when it waits. States come from Claude Code's own `~/.claude/sessions/*.json` (read only;
  each process is checked to be alive, including its start time, so crashed sessions and stale files
  don't show), from hook events, and from recent transcript activity. A session that just ended
  stays a while as Exited.
- **Actions:** Focus terminal (brings the Windows Terminal window forward and selects the session's
  tab, found by its name; WSL sessions too), Open on phone (a QR code of the Remote Control link),
  Copy resume command, and Mute.
- **Session alerts (opt-in per environment):** Settings → Session alerts adds a tiny hook script to
  Claude Code's `settings.json` for exact, instant states, after you review the diff. Your existing
  hooks are kept byte for byte (the app's go at the end of each list); Disable takes out exactly the
  app's. Installed scripts are updated with the app, like the status line bridge.
- **Alerts:** Windows notifications when a session needs approval, finishes (after a minimum working
  time), stops with an error, keeps waiting, or ends. Pick the events, set quiet hours (approvals can
  still come through), and mute single sessions. Clicking a notification opens the session.
- **Safety details:** the app's hooks are recognised only by their exact command (a wrapper of yours
  that mentions the script stays); Disable removes only their text, keeping comments and formatting;
  files with comments work and duplicate keys are refused. Both installers save settings.json the
  same way: a backup first, a flushed temp file, a last check that the file is still what you
  reviewed, then one atomic rename (settings.json never goes missing). The Windows hook command
  passes the script path as data, so no quote in a profile path can break out. Running processes are matched by their start time on every check. Focus
  terminal matches tab names exactly and won't guess between two equal names.
- **Phone:** a Running tab with the same view, and **push alerts** that arrive when the app is closed
  (opt-in per phone, Web Push). A push says only what happened, with an opaque reference; tapping it
  loads the details from the PC over Tailscale. Settings → Phone shows which phones have push on, and
  can send a test or turn it off.

- **Fix: per-project billing defaults for WSL.** "Always use this for <project>" was keyed by the
  folder alone, ignoring case, so the same path in two WSL distros, or two folders differing only
  by case, shared one billing default. It now uses the same project key as the model and effort
  defaults: distro and exact path for WSL, the folder (ignoring case) for Windows. Windows defaults
  keep working as they are. A WSL default saved by 1.4.0 or older is moved to every project it
  applied to before, as soon as the app has seen their sessions; one that matches no session yet
  is kept until it does.
- **Tests:** the browser tests no longer time out now and then. Their Vite servers watched the
  whole repo, so any file changed during a run (an edit, git, the formatter) reloaded the test page
  mid-test; and on a fresh cache (after `npm install`) Vite found dependencies while a page loaded
  and failed its requests ("504 Outdated Optimize Dep"). They now run without a file watcher,
  pre-bundle everything at start, keep their own caches, wait for menus instead of racing them, and
  run after the other tests, one file at a time.

## 1.4.0 (October 31, 2026)

**Session names from Claude Code, and the model and effort for each session.**

### Model and effort per session

- **Model and effort per session:** "Launch with" under the session's title, and the same pickers in
  the Resume / Fork / Branch dialog. Model: Default, the aliases (Fable, Opus, Sonnet, Haiku), models
  seen in your logs (most recently used first), or **Custom…** for any model ID or alias. Effort:
  Default, Low, Medium, High, Extra high, Max (what `claude --effort` accepts). Saved in the app's
  metadata, never in Claude's files.
- **Defaults:** Settings → Resume sets the default for every session; **Project default** next to
  the pickers sets one for a project (it changes only what the session sets, and keeps the
  project's other value). Order: the session, then its project, then Settings. Default adds no flag
  at all. WSL projects are told apart by distro and by case (`/home/me/App` and `/home/me/app` are
  different projects); Windows folders ignore case.
- **Every launch uses it:** Resume, Fork, Branch and New session, for Windows and WSL, with Remote
  Control, from a phone and on API credits, plus **Copy resume command**. A branch or a fork made
  from the app keeps its parent's choice for later resumes too. Model names are checked so nothing
  in them can reach a shell.
- **Shown where you launch:** a small badge on each session ("Opus · High"), on the Resume button
  ("Resume · Opus · High"), and on the phone (session cards, the session screen, the launch sheet;
  the phone can also change a session's choice and the defaults).
- **API credits, before you've set them up:** instead of no card at all, Usage shows a quiet "Track
  API credits: add a key and the amount you have" line with a button to Settings → Accounts & API
  credits.

### Session names from Claude Code

- **Names from `/rename`:** a session renamed in Claude Code (Windows or WSL) shows that name in
  the list, the viewer, search and on the phone, and updates live when you rename it again. The
  Remote Control name is used when there's no `/rename`. Claude's newer automatic titles
  (`ai-title`) count as its summary.
- **Title order:** the newer of your dashboard name and the Claude Code name, then Claude's
  summary, then the first message. The name editor says where the title came from ("From Claude
  Code", "Set in dashboard", "Auto").
- **Use name from Claude Code:** clears your dashboard name for a session (viewer ⋯ menu, the new
  right-click menu on list rows, the phone's menu). Pick several sessions to do it in bulk ("Use
  Claude Code names").
- **Keyboard multi-select (desktop):** Ctrl+click and Shift+click, or from the keyboard: Space
  picks the focused session, Shift+↑/↓ extends a range, Ctrl+↑/↓ moves without changing the picks,
  Ctrl+A picks the whole list, Esc clears. Plain ↑/↓ work as before.
- **A rename's time is the time of its `/rename`:** new messages never make an old name look newer,
  and `/rename` back to an earlier name counts as a new rename.
- **Drafts are safe:** a rename in Claude Code (or an edit from the phone) arriving while you type a
  name or description doesn't replace your text; the name editor offers the new name instead.
- **Your names stay:** on the first run of this version, names you set in the dashboard keep
  winning over names already in Claude's files; only a later rename in Claude Code replaces them.
  Names are only read from Claude's files, never written to them.

### Accessibility

- **Clickable usage cards:** the API credits card had a button inside a button (React warned about
  it). Clickable cards are now plain containers with a real button for their action, separate from
  the info button, so keyboard and screen-reader users reach each one on its own.
- **Model and effort pickers** work fully from the keyboard (Enter opens a picker and picks an item
  without starting the session), and every picker has a label that says its current value.

## 1.3.1 (October 31, 2026)

**Live limits that don't go stale without telling you.**

- **Fix: live limits froze on Windows.** The Windows status line bridge failed every update after
  a session's first one (PowerShell passed an empty backup path to `File.Replace`), so the gauges
  kept the last reading that had limits and showed 0% once that window reset. The fixed script is
  installed over the old one automatically at startup (only the app's own script file; Claude's
  `settings.json` isn't touched).
- **Readings recovered:** the limit data the old script left behind in `.tmp.*` files is imported
  into the limit history once, and those temp files are removed. Files that can't be read are left
  alone.
- **Stale readings are labeled, never shown as 0%:** once a window has reset since the newest
  reading, the gauges say "No recent reading", show the last known value ("5% as of Oct 23") and
  why there's no newer one. "Updated … ago" turns amber after an hour. The same on the tray icon,
  mini meter, title bar gauges and the phone. Limit health and "Where your limits went" explain
  missing data too.
- **Fix: WSL sessions missing until a manual rescan.** Sources were detected only at startup, so a
  distro that wasn't running yet (or stopped for a moment) stayed out of the list. Unreadable
  sources are now re-checked every two minutes and come back on their own.
- **Safety:** temp files are deleted only after their readings are saved to the history file, and
  only in that Claude home's own `.claude-session-dashboard/live` folder (links and junctions are
  followed and checked first). An installed bridge script is upgraded only if it's one the app
  shipped or wrote; a script you changed is left alone.
- **Rescan now** in the Usage view, with the time of the last scan. The weekly gauge is labeled
  "all models", and any per-model weekly window Claude Code may report is shown under it.

## 1.3.0 (October 24, 2026)

**A real terminal on your PC from your phone.**

- **Terminal access (SSH over Tailscale):** Settings → Terminal access (SSH) sets up Windows' own
  OpenSSH Server step by step, with a live check at every step: install, a firewall rule limited to
  Tailscale (Windows' "any address" rule turned off with your OK), the default shell (PowerShell 7,
  Windows PowerShell or WSL), your phone's key, the phone app, and a test.
  - Every change shows the exact script first, asks Windows for administrator rights, is logged,
    and has its own Undo. **Turn off terminal access** undoes everything the setup changed.
  - **Keys:** paste your SSH app's public key, or send it from the dashboard on your phone (**Send
    SSH key to PC**) and allow it on the PC after comparing fingerprints. Then turn password login
    off (sshd_config is backed up first).
  - Shows the PC's host-key fingerprints to check when your SSH app first connects.
- **Open terminal here** on every session and project. On the PC it opens a terminal in that
  folder. On the phone it gives an `ssh://` link and a copyable command that lands in the folder,
  for PowerShell or WSL. It only appears once terminal access is set up.
- **Copy AI help prompt** in both Troubleshooting panels: paste it into Claude or another AI
  assistant for help with a connection. It points the assistant at the new
  `docs/AI-SETUP-GUIDE.md` (read-only checks first, your OK before any change, no secrets).
- Safety: SSH is reachable only over Tailscale; the dashboard never runs commands for the phone, and
  never deletes keys or settings you had before.

## 1.2.0 (October 23, 2026)

- Add Copy buttons for messages, code blocks, full tool input/output and whole conversations, with a
  clipboard fallback.
- Fix text selection on desktop and phones while preserving mouse context menus and branch actions.
- Make mobile Copy actions visible and easy to tap, including in long messages and tool output, and
  keep tool-copy buttons clear of Find.

## 1.1.0 (October 23, 2026)

**Use it from your phone.**

- **Remote Control:** Resume, Fork and Branch can start Claude Code with Remote Control on, named after
  your session, so you can continue it in the Claude app or at claude.ai/code. Turn it on per launch,
  or by default in Settings → Resume. Sessions launched this way get a **📱 Remote** badge that links
  straight to them.
- **Phone companion:** the dashboard on your phone, in a phone layout. Search and read sessions,
  rename, describe, tag, pin and hide them, check usage and limits, and resume, fork or branch
  sessions on your PC. It updates live and installs to the home screen.
- **Connect your phone:** Settings → Phone walks you through Tailscale (recommended: private, works
  from anywhere, real HTTPS) or home Wi-Fi only, pairing by QR code, a test message and a Remote
  Control check. A troubleshooting panel is included.
- **Safety:** phone access is off by default and listens only on this PC (127.0.0.1); Tailscale
  publishes it to your own tailnet only, never the public internet.
  - Each phone has its own key, which you can revoke; phones unused for 30 days are forgotten.
  - Launches from a phone always use your Claude subscription and keep permission prompts on.
  - Optional read-only mode, confirm-on-PC, and an activity log of every action from a phone.
- **Pin to top** for sessions.

Reviewed in five independent passes (one security review, four code and security reviews); every
finding is fixed and covered by a test.

## 1.0.0

First release: browse, search, name, archive and resume every Claude Code session from Windows and
WSL, with usage, limits and API credit tracking.
