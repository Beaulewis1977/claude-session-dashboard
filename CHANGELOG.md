# Changelog

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
