# Changelog

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
