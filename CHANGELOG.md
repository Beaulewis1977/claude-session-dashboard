# Changelog

## 1.16.4 (November 11, 2026)

**Big sessions open much faster, and the app uses less memory.**

### Big sessions and memory (PR #60)

- **Long tool inputs are trimmed.** Files Claude wrote, edits and patches used to arrive in full
  in the viewer. Now each long one shows its start with a **Show full (N lines, M chars)** button
  that loads the rest. Tool outputs arrive as exactly what the viewer shows before **Show all**,
  so nothing looks different until you open one. **Copy input**, a message's **Copy**, **Copy
  conversation** and **Find** still use the full text: Find counts and opens matches past the cut,
  including later ones and quoted or escaped text.
- **Very long sessions** (like a 715-message one with thousands of tool calls) get one-line
  placeholders: a tool call loads its output and input when you open it and shows them as usual.
- **Only large sessions are virtualized.** A session is drawn near the screen only when it would
  draw more than about 3,000 elements (an estimate from its content, not its number of turns).
  Short and medium sessions are drawn in full, so you can select text across the whole
  conversation again.
- **Lower memory.** Usage reports and the Codex fork check make far less garbage (about half),
  and the usage reader thread stops right after a scan instead of 20 seconds later. **Every usage
  and limits number is the same as before**, to the last digit.

| | Before (1.16.3) | After (1.16.4) |
|---|---|---|
| Biggest session (715 messages): sent to the viewer | 14.5 MB | 2.7 MB |
| …opens in | 445 ms | 368 ms |
| Idle memory: main process | 798 MB | 428–472 MB |
| Idle memory: all processes | 1,156 MB | 812–846 MB |
| On Usage (All): all processes | 1,384 MB | 1,286 MB |
| On Usage (Claude Code): all processes | 1,545 MB | 1,392 MB |

Measured on a real history (148k Codex + 16k Claude Code responses, 2,575 sessions), built app,
same steps.

**Known limits:** opening the Usage screen still briefly takes the main process to about 600 MB
before that garbage is collected, and opening a tool call in a very long session after two minutes
idle takes about 0.3 s (the session is read again).

### Also in this release

- `CSD_TIMING=1` also logs main-process memory and each worker thread's heap every 10 seconds.
- A performance harness in `scripts/perf/` measures the app on a copy of real data before and
  after a change (numbers only).

## 1.16.3 (November 11, 2026)

**Performance: a fast Usage screen, a smoother viewer, and smaller installers.**

### Performance (PR #58)

- **The Usage & limits screen no longer freezes.** Opening it and switching ranges, Day/Week/Month
  or sub-tabs now takes a fraction of a second instead of several seconds. **Every number is the
  same as before**, to the last digit (a test compares the new code against the old calculation).
- **How:** each usage report used to re-add every raw record (163k on a big history) on the main
  process, twice. Now the records are indexed once, each report is fetched once, results that
  can't have changed are kept, and change notices are batched. Session files are read for usage in
  a background thread that ends when idle.
- **The screen itself:** charts don't redraw or re-animate when nothing in them changed (the gauges
  keep their fill animation), the main chart shows at most 400 points (totals unchanged), and the
  Raw table only draws the rows you can see. The Usage, Settings and Ask screens load on demand, so
  startup loads 1.3 MB of code instead of 4.3 MB.
- **Big sessions in the viewer:** tool outputs over 8,000 characters arrive cut, with their real
  size; **Show all**, **Copy output**, **Copy conversation** and Find past the cut still get the
  full text. Long sessions only draw the turns near the screen; Find still counts and reaches every
  match. The phone still gets transcripts in full.
- **Session list:** windows get only what changed, not the whole list, on every update.
- **Smaller installers:** only the built app is packed (a build check now fails if anything else
  gets in), no `node_modules` ship, and only the English locale.

| | Before (1.16.2) | After (1.16.3) |
|---|---|---|
| Open Usage: Claude / Codex / All | 0.8 / 5.7 / 6.0 s | 0.05–0.2 / 0.33 / 0.34 s |
| Range switch: Claude | 0.6–4.2 s | 85–103 ms |
| Range switch: Codex / All | 2.3–11.9 s | 72–197 ms |
| Day / Week / Month | 0.6–3.5 s | 43–87 ms |
| Sub-tabs | 40–1,290 ms | 23–192 ms |
| Longest freeze on Usage (renderer) | 423 ms | 51 ms |
| Main-process stalls over 50 ms / over 500 ms / worst | 98 / 49 / 3.9 s | 16 / 0 / 465 ms |
| Installer / portable | 108.9 / 108.6 MB | 100.4 / 100.1 MB |
| Installed size | 365.5 MB (75 files) | 315.2 MB (21 files) |

Measured on a real history (148k Codex + 15k Claude Code responses, 2,593 sessions), built app,
same steps. Startup time is unchanged (the session scan dominates).

**Known limits:** memory on the Usage screen (All) is still about 1.75 GB at peak (most of it
garbage that is collected later), and the biggest transcripts are still large because of long tool
*inputs* (for example whole written files). These are on the roadmap.

### Also in this release

- Builds from v1.10.0 to v1.16.2 accidentally packed a few leftover development files (a build log
  and PR description drafts) into the installer. They're gone from 1.16.3, and the build now
  refuses to pack anything outside the app itself.
- `CSD_TIMING=1` also logs slow or big IPC calls and stalls over 50 ms.

## 1.16.2 (November 10, 2026)

**Fast mode as a launch option.**

### Fast mode (PR #56)

- **A Fast picker next to Model and Effort** (Default, On or Off; off unless you turn it on) in
  Resume, Fork, Branch, Continue fresh and New session, under the session's title, and on the phone
  (session screen and launch sheet). A short note says "Faster replies, uses limits faster / costs
  more"; the ⓘ has the details and prices.
- **Remembered like the model and effort:** per session, per project (**Project default**), and in
  Settings (Claude Code: Settings → **Resume**, also on the phone; Codex: Settings → **Providers**,
  kept apart). A branch or a Continue fresh keeps the parent's choice.
- **Only for models that have it:** Claude's Opus 5.5, Fable 5.2 and Opus 5 (and the `opus` and
  `fable` aliases), and the Codex models whose entry in Codex's own `models_cache.json` (read only,
  each home's own list) offers the Fast tier. The model that counts is the one you picked, else the
  model of the session's last reply (for a branch, the last reply it keeps). New session and
  Continue fresh run on the agent's default model, so Fast is shown there with a note.
- **Claude Code** gets `--settings` with the app's own `launch\fast-mode.json`, holding only
  `{"fastMode": true}` and checked before every launch, so none of your other Claude Code settings
  change (WSL sessions get the same file as the distro sees it). On the subscription the dialog
  says it's billed to usage credits (not your plan limits) and needs them turned on in your Claude
  account; on an API key, that it's billed at the fast prices.
- **Codex** gets `-c service_tier=fast`. It uses your limits at 2.5×, so the launch dialog and the
  phone warn when Codex's 5-hour window is above the pause line in Settings → **Summaries**.
- **Every launch path:** Windows Terminal, PowerShell, cmd, WSL, Remote Control, phone launches and
  API billing, and **Copy resume command**. The Resume button and the session badges say "Fast".
- **Open in Claude desktop app / Codex app:** fast mode isn't passed there; the dialog says to turn
  it on in the app.

### Also in this release

- **Claude Console personal API keys** (`sk-ant-usr-…`, what the Console creates now) are accepted
  in Settings → **Accounts & API credits**; they were refused as "Not a valid key". The dialog says
  to scope a personal key to a workspace when you create it.
- Sessions now record the model of their last reply. **After updating,** the app re-reads its
  session list once at startup.
- README: a **Token speed** section (what 1.16.1 added) and **Fast mode**.

## 1.16.1 (November 10, 2026)

**Token speed: how fast Claude and Codex answer.**

### Token speed and time to first token (PR #54)

- **Output speed (tokens per second)** for every Claude Code and Codex response, worked out from
  the timestamps in the logs (never from message text). Time spent running tools isn't counted.
- **Time to first token:** Codex's own per-turn figure, and an estimate for Claude Code (only for
  replies that start with thinking; the tooltip says what share of replies it comes from).
- **Trends** (Claude Code and Codex, kept apart): weekly median output speed, output speed without
  thinking/reasoning, and Claude's time to first token (est.), per model and per CLI version, with
  the usual change markers and Compare.
- **All view:** a combined "Output speed by model" chart, each line tagged Claude Code or Codex.
- **Usage:** tok/s on the period cards and next to each model in the Models card.
- **Each session** (desktop and phone): tok/s, time to first token and a Fast badge in the usage
  strip, with a tooltip.
- **Limit health:** a "Speed" row that compares each busy model's last 7 days with the 4 weeks
  before. It's an extra signal only, never part of the score.
- **Fast mode is tracked separately:** Claude Code's fast responses and Codex's priority tier are
  counted as `<model>-fast`, get their own dashed line and compare rows, never mix into a
  normal-mode median, and are priced at the official fast prices.
- **Prices:** Claude Fable 5.2 and Mythos 5.2 added from Anthropic's pricing page. A newer minor
  version is no longer silently priced by an older model's row.
- **CSV export:** the per-response file gets `thinking_tokens`, `gen_ms`, `ttft_ms`,
  `tokens_per_sec` and `fast_mode`; the daily file gets `median_tokens_per_sec` and
  `speed_samples`.
- Speeds are medians and need at least 5 responses. Very short replies, replies cut short or after
  an API error, impossible timings and copied history (forks, subagents that inherit their parent's
  history) are left out of the medians; they still count everywhere else.
- **After updating,** the app re-reads all Claude Code sessions and Codex rollouts once, in the
  background. Speeds fill in as they are read, and a restart picks up where it stopped.
- Speed is an estimate: it includes waiting and thinking time, and network and server load affect
  it. Only timings are stored, no content.

## 1.16.0 (November 10, 2026)

**Ask across all sessions.**

### Ask across all sessions (PR #50)

- Ask questions about your whole Claude Code, Codex and Claude desktop (and Cowork, when that
  source is on) history from the new Ask screen (sidebar, Ctrl+Shift+K or the command palette).
- **Local questions** about facts the app already has (counts, dates, models, usage, spend,
  limits, plans, commits, PRs, files touched) are answered on your PC with nothing sent, and show
  how they were computed. They work even while content questions are off.
- **Content questions** are off until you turn them on in Settings → Ask. They search a local
  keyword index (built in a background worker after you turn Ask on, saved in the app's cache) and
  are answered by Claude through your own CLI:
  - a preview of exactly which snippets are sent (untick any snippet or session, see the exact
    text), with common secret shapes masked;
  - the 5-hour limit guard (the preview warns above the pause line); usage is recorded as
    "Ask (dashboard)";
  - citations that open the exact message or commit; statements without a source are removed
    and listed, and "Not found in your sessions" when nothing supports an answer.
- Model and effort pickers next to Send (defaults in Settings → Ask, remembered for the next
  question), scope filters (agents, sources, environment, dates, projects, subagents, hidden),
  suggested questions, Copy with numbered sources, a searchable history you can delete from item by
  item, and Back/Forward support.
- Settings → Ask: on/off, default model and effort, snippet limits, index size limit, Rebuild and
  Delete index.
- **Phone:** an Ask tab with your past answers. Local questions are answered directly; content
  questions are sent to the PC for approval and nothing goes to Claude until you review the
  preview there and click Send (expires after 15 minutes).

## 1.15.2 (November 10, 2026)

**Back and Forward.** (1.15.1 was built but not released: its title-bar buttons didn't take
mouse clicks.)

### Back and Forward navigation (PRs #46, #48)

- Back and Forward navigation: title-bar buttons with tooltips, Alt+←/Alt+→, Backspace (outside
  text fields) and the mouse side buttons. Restores the screen, selected session, viewer tab, Usage
  sub-tab, provider view, Settings section and scroll position; skips deleted sessions. The
  phone's back gesture now follows tabs and sessions too.
- **Fixed:** the title-bar buttons (sidebar toggle, Back, Forward) didn't respond to the mouse or
  show tooltips; the search box's centring area covered them as part of the window's drag area.
- **Fixed:** after switching Claude/Codex or a filter that hides the selected session, Back skipped
  the screen you were on.

## 1.15.0 (November 9, 2026)

**Moving between PC and phone, and Claude desktop sessions.**

### Remote continuity and Claude desktop sessions (PR #44)

- **No second terminal for a session already running on your PC.** Before Resume, Fork or
  Continue fresh, the app checks Running now (for Fork and Continue fresh: a still-running fork or
  continuation it launched earlier; forking a running session itself stays allowed).
  - **Phone, Remote Control on:** "Already running on your PC" with **Open in Claude app** (the
    session's Remote Control link).
  - **Phone, Remote Control off:** it tells you to type `/rc` in that terminal, then refresh.
    Nothing is launched.
  - **Focus terminal on PC** from the phone (starts nothing, rate-limited, logged, refused in
    read-only mode).
  - **Desktop:** the Resume dialog offers **Focus terminal** first.
  - **Start another copy anyway** is always there, behind a confirm (still rate-limited, logged,
    Remote Control on, never skip-permissions).
- **Remote Control links are picked up within seconds of `/rc`** (a link from an earlier run
  doesn't count).
- **Codex:** the same duplicate check, **Focus terminal on PC** from the phone, and **Open in
  Codex app** (with a confirm while a terminal still runs it). The app notes that Codex Remote
  (ChatGPT app) reaches Codex app threads only, so continue on the phone via the Codex desktop app.
- **Open in Claude desktop app** (`claude --desktop --resume`) for Windows sessions with Claude
  Code 2.1.285 or newer. Resume only: Fork isn't offered there yet.
- **"Claude desktop" as its own source label and sidebar entry** for the desktop app's Code-tab
  sessions.
- **Optional "Claude desktop (Cowork)" source**, off by default (Settings → Sources). View-only:
  read, search, usage and git links, no launching or summaries. Only each task's session
  transcripts are read; credential files are never read, archived or backed up.
- **Fixed:** local sessions with a Remote Control link were labelled "Cloud (teleported)". The
  session cache is re-read once after the update.
- **Clearer Remote Control label:** it says the session can be continued from the Claude mobile
  app.

## 1.14.0 (November 9, 2026)

**Git links.**

### Git links (PR #41)

- **Each Claude and Codex session is linked to the commits it made:** exact matches from session
  trailers and commit output, plus branch, time and file matches with confidence levels.
- **A Changes tab** in the viewer with the session's commits, files, diffs and PR links, plus
  "Sessions that touched this file".
- **Badges on session cards**, and `touched:<path>` and `commit:<sha>` search.
- **Unlink / restore** a link (kept in the app's metadata).
- **Optional PR lookup via your GitHub CLI** (asked once; switch in Settings → Git).
- **A read-only Changes section on the phone.**
- Git is only ever read, never modified.

## 1.13.1 (November 9, 2026)

**Loose ends after 1.13.0.**

### Fixes and small additions (PR #39)

- **Phone companion secrets on the async safeStorage API**, with a transparent one-time migration
  of the existing keys (paired phones stay paired).
- **Faster first page load:** the first Resume dialog opens quickly at startup, and the browser
  tests share one cache and run reliably.
- **Restore safety copy cleanup** in Settings → Backup (see the size, clean up by hand or
  automatically, opt-in).
- **Catch-up backups:** a missed daily backup runs shortly after start, with a notification when
  it finishes (and a report when the backup folder isn't ready).
- **Start with Windows** (optional), minimized to the tray.
- **Codex:** fork ordering in usage and the one-account plan detection fixed.
- **Windows notifications show reliably:** a fixed app identity (AppUserModelID), plus a
  notification log (`logs\notifications.jsonl`).

## 1.13.0 (November 9, 2026)

**Open in Codex app.**

### Open in Codex app (PR #37)

- **Resume Codex sessions in the Codex desktop app**, in their own project.
- **Fork** opens the thread with a pointer to the app's Fork menu.
- **Continue fresh** starts a new thread in the matching project with the handoff ready to send
  (with a clipboard fallback for long handoffs).
- **"Open in: Terminal / Codex app"** remembered per session, project and globally.
- **From the phone:** open the existing thread in the Codex app on your PC.

## 1.12.0 (November 8, 2026)

**Codex support (part 4, complete).**

### Codex summaries, Continue fresh, agent messages & trends (PR #35)

- **Summaries for Codex sessions** (written by Claude; a `codex exec` option waits for a real
  no-tools switch in Codex).
- **Continue fresh for Codex** with its own handoff folder and automatic "continued from" linking.
- **Agent-to-agent messages** shown as collapsible steps in the Codex viewer.
- **Codex Trends tab:** output / reasoning tokens, latency, tool errors, aborts, cache ratio and
  context use.
- **Handoff folder size and cleanup** in Settings.
- **Continue fresh for Codex from the phone.**

## 1.11.0 (November 8, 2026)

**Codex support (part 3): Codex sessions in Running now, with alerts.**

### Codex Running now & alerts (PR #33)

- **Codex sessions in Running now** (CLI, VS Code, desktop app; Windows and WSL) with Working /
  Needs approval / Waiting for you / Exited, using Codex's own thread locks.
- **Codex alerts on desktop and phone.**
- **Optional Codex approval hook** (opt-in, trusted via `/hooks` in Codex) for exact approval
  alerts.
- **Focus terminal** and **Open in Codex app.**

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
