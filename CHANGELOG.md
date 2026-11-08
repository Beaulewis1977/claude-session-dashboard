# Changelog

## 1.10.0 (November 8, 2026)

**Codex support (part 2): Codex usage and limits, side by side with Claude.**

### Codex usage & limits (PR #30)

- **Codex token usage per model, session, project and client**, with fork-aware de-duplication.
- **Live Codex limits** (5-hour, weekly and per-model limits like Spark) with history, stale
  handling and 75/90% alerts.
- **Codex plan detection, limit health and pacing**, with their own baseline.
- **Codex context size and resume warnings.**
- **All view** with side-by-side Claude and Codex gauges and stacked / split charts.
- **Tray, mini meter and status bar** can show Claude, Codex or both.
- **CSV export** has a provider column.

## 1.9.0 (November 3, 2026)

**Codex support (part 1): browse, read, search, name, tag, resume and fork OpenAI Codex sessions.**

### Codex sessions (PR #28)

- **Browse, read, search, name, tag, resume and fork OpenAI Codex sessions** from Windows, WSL and
  the Codex desktop app, including compressed `.zst` rollouts and Codex's own thread names.
- **All / Claude / Codex switch** on the desktop and the phone.
- **Settings → Providers** to turn Claude or Codex on or off.
- **Per-session Codex model and reasoning effort.**
- **Optional Codex archiving** (off by default).
- **Codex subagents hidden by default.**
- **Smart handling** of WSL paths and Codex desktop-app sessions.
- Codex usage / limits and the remaining Codex features come in later releases.

## 1.8.1 (November 2, 2026)

**An internal restructure with no visible changes: the groundwork for Codex support.**

### Provider architecture (PR #26)

- Everything that knows about Claude Code (finding and reading sessions, resume / fork / branch /
  Continue fresh commands, usage and limits, Running now, session lineage) now lives behind one
  **provider** interface, with Claude as its first provider. This prepares the app for Codex
  sessions, usage and limits in the next steps.
- **Nothing you can see changes:** the same sessions, names, launch commands, usage numbers, limits
  and alerts as 1.8.0. Golden "parity" tests capture the app's output before and after the
  restructure (in two time zones) and check that they match.
- The summary prompt can name the session's agent; for Claude Code sessions the text sent is
  exactly the same as before.
- Docs: the provider layer is described in `docs/DETAILS.md`.

## 1.8.0 (November 2, 2026)

**Context size before you resume: see how big each session is, and get warned before reloading a
large one.**

### Context size before you resume (PR #24)

- **Context size per session:** the last reply's context (input + cache tokens), or the status
  line's reading when it's newer. Right after a compaction it's estimated from the summary.
  Sessions without usage data show no size.
- **On every card:** an S / M / L / XL badge (exact tokens on hover), and a **Context size** sort.
- **In the viewer:** tokens, the % of the model's context window ("9% of 1M · Opus 5.5", with where
  the number comes from on hover), compactions, and what resuming would use next to what Continue
  fresh would use.
- **A warning before resuming a large session** (150k tokens by default, Settings → Context size):
  "Large session: about 180K tokens. Resuming may use about 12% of your 5-hour window", with
  **Continue fresh** (or **Summarize first**), **Fork · same size**, **Resume anyway** (still one
  click) and **Don't warn for this session**. Switching to Fork or Continue fresh keeps the choices
  you made in the dialog. Same on the phone.
- **The estimate:** the context priced at the launch's model as a prompt-cache write, turned into a
  share of the 5-hour window by the limit-health baseline (or this window's own subscription use
  when there's no baseline yet); tokens only when neither is known, dollars on API credits.
- **Warm cache:** when the last reply was recent enough, the part of the prompt cache that may still
  be alive (5-minute and 1-hour parts counted separately) is priced as a cheaper read: "Cache may
  still be warm, cheaper if you resume now". Only for the same model and billing account, and the
  estimate updates by itself when the cache runs out.
- **Context window per model:** `[1m]` variants and models with a native 1M window (Opus 4.7+,
  Sonnet 5+, Haiku 5.5+, Fable 5+) count 1M, others 200k; a session's own status line reading is
  used for the model it was taken for.
- Continue fresh is priced at the model you chose; with Claude Code's default model (which the app
  can't see) both sides are compared in tokens.
- Open launch dialogs and the viewer follow the session as its context changes and as limits update.
- The summaries' limits guard and the resume estimate share one baseline and one "this window's
  rate" helper, which now needs the window's start (otherwise it says unknown).
- The session cache is rebuilt once on the first start (a full rescan).

## 1.7.0 (November 2, 2026)

**Session summaries, and Continue fresh: start a new session from a summary instead of reloading
the whole history.**

### Session summaries and Continue fresh (PR #22)

- **Summaries.** A short summary per session (suggested title, what was done, files changed,
  decisions, open to-dos, where to pick up) at the top of the viewer and as one line on each card,
  on the desktop and the phone. Written by Claude through your own Claude Code (`claude -p`, the
  same isolated, subscription-only runner as Ask Claude, plus `--no-session-persistence`), only
  when you ask: **Summarize**, **Summarize selected**, or opt-in auto-summarize for big idle
  sessions (off by default). Editable, regenerable, part of search and backups, stored only in the
  app's metadata, never in Claude's files.
- **What is sent:** user and assistant text plus one line per tool call, never tool output,
  thinking or images, with common secrets masked, cut to a size limit keeping the start and the end.
  A one-time notice explains it, with the exact text on request.
- **Limits guard:** Summarize selected shows an estimate first (tokens, and roughly the share of
  your 5-hour window from the limit-health baseline). The queue pauses when the live 5-hour limit
  is above 80% (Settings → Summaries), with **Resume anyway**; auto-summarize skips while above it.
- **Usage:** each summary run's tokens are recorded from Claude Code's answer as "Summaries
  (dashboard)", so they show in Usage and count in limit health.
- **Continue fresh** starts a new session in the same folder from the summary instead of reloading
  the whole history, with the same options as Resume. The summary goes into a handoff file in the
  app's data folder that the first message @-mentions, so it never goes on a command line. The new
  session shows as "continued from" in the Branches panel. Also from a phone (a fourth fixed launch,
  with the same rules as Resume, Fork and Branch).
- **What you preview is what is sent:** a previewed text is sent exactly as shown (or not at all),
  and Cancel works up to the moment anything is sent. A queued summary you didn't preview sends the
  session's content as it is when the summary runs. The limits guard counts the summaries' own usage since the latest live reading,
  and Summarize waits for the estimate.
- Cancel works while a request is still reading its sessions ("Preparing… (n/N)"); a text you
  previewed stays the one that's sent even if you hide it; and a summary run counts from when it
  finished. If the guard can't tell what the last summaries used, the queue pauses until you click
  **Continue**. A phone launch is checked again right before the terminal opens.
- Continue fresh in WSL asks the distro where it sees the handoff file (custom automount roots
  work) and starts nothing if the distro can't read it. Its command can't be copied, since the
  handoff exists only when the app launches it.
- **Regenerate** on the summary is now a labelled button, not just an icon.
- The launch and Summarize dialogs scroll when they're taller than the window, instead of hiding
  their buttons.

**Known issue:** a queued summary you didn't preview sends the session's content as it is when the
summary runs, not as it was when you queued it.

## 1.6.0 (November 1, 2026)

**Backups of everything the app keeps, to a folder you choose, plus Running now, session alerts and
phone push alerts.**

- **Running now, session alerts and phone push alerts** (PR #18) first shipped in 1.5.0 and are part
  of this release too; see 1.5.0 below for the details.

### Backups (PR #20)

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
