# Claude Session Dashboard: Feature Roadmap

Ideas to build next, with the details and a ready-to-paste prompt for each.

**Current state (Oct 31, 2026):** v1.4.0 installed. It includes:
- session browsing, names synced from `/rename`, and per-session model and effort;
- live limits, usage tracking, and limit-health detection;
- phone companion, Remote Control and terminal access over Tailscale;
- branching from any message.

---

## How to use this doc

**One feature at a time, each in a fresh Claude Code session on your PC.** Several running at once would conflict, because they touch the same parts of the app.

The loop for every feature:

1. Open a **new** Claude Code session in the project folder and paste the feature's prompt.
2. When the PR is ready, try it with `npm run dev`: quit the installed app first, then check out the branch, `npm install`, and `npm run dev`.
3. Send the **Codex review prompt** (in the Templates section at the end) with the PR number filled in.
4. Fix what's worth fixing in **one round** (blockers and should-fix items; skip unlikely edge cases), then merge with **"Create a merge commit"**.
5. Release when you've finished a batch, using the **Release prompt** template.

**Every prompt already includes these rules:** new branch from `main`, PR into main, no merging, no pushing to main, no GitHub Actions, and ask before deleting anything or changing system settings.

---

## Suggested order

| # | Feature | Why this order | Size |
|---|---------|----------------|------|
| 1 | Live sessions & "Claude needs you" alerts | Biggest day-to-day win | Medium |
| 2 | Archive backup | Quick, and protects everything else | Small |
| 3 | Session summaries & "Continue fresh" | Makes old sessions readable and cheaper to resume | Medium |
| 4 | Context size before resume | Builds on #3 | Small |
| 5 | Codex support (Claude, Codex, or both together) | Big; easier once the features above exist | Large |
| 6 | What each session changed (git links) | Nice to have | Medium |
| 7 | Ask across all sessions | Most advanced; best done last | Medium–Large |

You can do Codex earlier if you're using it a lot. Its prompt tells the agent to bring every existing feature to Codex, so features built *before* it get Codex support for free. For features built *after* it, each prompt includes a Codex line.

---

## 1. Live sessions & "Claude needs you" alerts

**What it is:** a "Running now" view showing every active Claude Code session. For each one it shows what it's working on and whether it's busy, waiting for your approval, or finished. You get alerts on your PC **and phone** when a session needs you or finishes.

**Why it matters:** with several sessions running, you stop checking terminals to see who's stuck. The dashboard becomes your control center, not just a history browser.

**How it works:**
- Claude Code's official **hooks** (Notification, Stop, and others) run a small script on each event. The dashboard uses this the same way the status line bridge works.
- Running sessions also show up in `~/.claude/sessions/*.json`, with PID, session and name.
- Installing the hooks changes `~/.claude/settings.json`. It's opt-in, shows you the exact change, backs up first, and can be undone, the same as live limits.

**Details:**
- A "Running now" sidebar entry and a section at the top of the list. Each running session has a status chip: Working, Needs approval, Idle, or Done.
- Phone push notifications (when the dashboard is installed to the home screen) and desktop toasts. Per-session mute.
- Actions: **Focus terminal** (brings that window forward), **Open on phone** (Remote Control), **Copy resume command**.
- History: how long each session ran, and how long it waited for you.

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/live-sessions-alerts`.

Read CLAUDE.md and the codebase first. Follow all CLAUDE.md rules and match the existing UI (desktop and phone). ASK ME before changing any settings outside the app.

Goal: a "Running now" view of active Claude Code sessions, with alerts when a session needs me or finishes.

1. Research on this machine (Windows + WSL): check the current Claude Code docs and `claude --help` for hooks (Notification, Stop, SubagentStop, UserPromptSubmit, SessionStart/SessionEnd, etc.) and their JSON payloads. Also look at ~/.claude/sessions/*.json for running sessions (pid, sessionId, name, cwd). Report what's available before building.
2. Hook bridge (opt-in, same safety model as the status line bridge):
   - Small dependency-free scripts (PowerShell for Windows, sh for WSL) that save each hook event atomically to <env home>/.claude-session-dashboard/events/. Fast, never fail loudly, exit 0.
   - "Enable session alerts" per environment adds our hooks to ~/.claude/settings.json: show the exact diff first, back up, keep all my existing hooks (append, never replace), with an exact Undo. Auto-upgrade our own scripts the same way as the bridge.
3. Running-now model: combine ~/.claude/sessions/*.json (check PIDs are alive), hook events and recent JSONL activity into a status per session: Working, Needs approval, Idle (waiting for my next message), Done/Exited. Handle stale files and crashed sessions.
4. UI:
   - A "Running now" sidebar entry with a count badge, and a "Running now" section at the top of the session list.
   - Status chips, elapsed time and "waiting for you since …".
   - Actions: Focus terminal (bring the Windows Terminal window or tab forward if possible, otherwise explain), Open on phone (Remote Control link if the session has one), Copy resume command.
   - Phone: the same view, with push notifications through the PWA (Web Push to my paired devices only, over the existing Tailscale connection) plus desktop toasts. Settings: which events alert, quiet hours, per-session mute.
5. Codex (only if Codex support already exists in the app): show running Codex sessions too, using whatever Codex exposes locally (check its docs for hooks/notify config and rollout activity). Otherwise skip.
6. Tests: hook payload parsing, settings.json merge/undo keeping existing hooks, status computation (dead PIDs, stale files), and notification rules.

Run typecheck, lint, tests and the build. Commit, push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link and a short summary.
```
</details>

---

## 2. Archive backup

**What it is:** a scheduled, encrypted backup of the dashboard's archive (every session, plus your names, notes, tags and usage history) to a folder you choose, such as OneDrive, an external drive or a NAS.

**Why it matters:** Claude Code deletes sessions after 30 days, so the dashboard's archive is now the **only** copy of your older work. If your PC dies, it's gone without a backup.

**Details:**
- Choose a destination folder. The cloud service, if any, does the syncing. The app makes **no network calls**.
- Incremental: only new or changed files are copied. Daily by default, plus a "Back up now" button.
- Optional encryption with a password you set. Without the password, the backup can't be read.
- Restore: browse backups, restore into the app's data folder (never into `.claude`), with a preview of what will change.
- Keeps a set number of snapshots, and only deletes old snapshots inside the backup folder, as you configure.

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/archive-backup`.

Read CLAUDE.md and the codebase first. Follow all CLAUDE.md rules and match the existing UI. ASK ME before deleting anything outside the backup folder I choose.

Goal: scheduled, incremental, optionally encrypted backups of the app's data (archive, metadata, usage and limit history, settings; never API keys in plain text) to a folder I choose (e.g. OneDrive, external drive).

1. Settings → Backup: destination folder picker, schedule (off / daily / weekly, default daily), "Back up now", last backup time/size/status, and a retention setting (keep last N snapshots, default 14).
2. Incremental: content-hash based, so unchanged files are not copied again. Write a manifest per snapshot. Atomic: a snapshot only counts as complete after its manifest is written.
3. Optional encryption: password-based (scrypt/argon2-style key derivation in pure JS + AES-256-GCM via Node crypto). Never store the password in plain text; offer "remember on this PC" via Electron safeStorage. Clear warning: lost password = unreadable backup.
4. Restore: list snapshots, show what would change, restore only into the app's own data folder (%APPDATA%\ClaudeSessionDashboard), never into .claude. Back up the current data first.
5. Retention only deletes old snapshots inside the chosen backup folder. Never delete anything else.
6. No network calls; the cloud app syncs the folder.
7. Include Codex sessions in the backup too, if Codex support exists.
8. Tests: incremental copy, interrupted backup, encryption round-trip and wrong password, retention, and restore never touching .claude.

Run typecheck, lint, tests and the build. Commit, push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link and a short summary.
```
</details>

---

## 3. Session summaries & "Continue fresh"

**What it is:**
- A short summary for each session: what was done, which files changed, decisions made, and open to-dos. Shown on the session card and at the top of the viewer.
- **"Continue fresh":** starts a *new* session seeded with that summary instead of resuming the whole huge history.

**Why it matters:** old sessions become readable at a glance. Resuming a long session reloads its whole history and uses a lot of your 5-hour window, so a summary handoff is much cheaper.

**Details:**
- Generated with `claude -p` on your subscription, only when you ask (per session or in bulk), or automatically for sessions over a size you choose (opt-in).
- The summary is stored in the app's data. It can be edited and regenerated, and shows the date and model used.
- "Continue fresh" opens a terminal with a new session in the same folder, with the summary as the first message, and links the new session to the old one ("continued from").
- Privacy: the conversation is sent to Claude through your own CLI. A clear notice explains this the first time.

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/summaries-continue-fresh`.

Read CLAUDE.md and the codebase first. Follow all CLAUDE.md rules and match the existing UI (desktop and phone).

Goal: AI summaries of sessions, and "Continue fresh" to start a new session from a summary instead of resuming the full history.

1. Summaries via the official CLI on my subscription: `claude -p` with the prompt on stdin (never in arguments), no tools allowed, never --dangerously-skip-permissions, with a timeout and Cancel. Reuse the existing "Ask Claude" runner and its rules (marker text, hide those runs from the session list by default).
2. Content sent: the session's user/assistant text plus short tool summaries (tool name + file paths, not full outputs), trimmed to a size limit with the start and end kept. Show a one-time notice that session content is sent to Claude through my own CLI, plus a preview option.
3. Summary format: a title suggestion, 3–6 bullet "What was done", "Files changed", "Decisions", "Open to-dos", "Where to pick up". Stored in app metadata with date and model, editable, regenerable. Never written to Claude's files.
4. UI:
   - A summary block at the top of the viewer and a one-line preview on session cards.
   - "Summarize" per session, bulk "Summarize selected", and opt-in auto-summarize for sessions over N messages (default off).
   - Make summaries part of the full-text search.
5. "Continue fresh": starts a NEW session in the same cwd and environment with the summary as the first message (via stdin or a temp file the CLI reads, never as a long command-line argument). Uses the same launch options as Resume (model/effort, billing, terminal, Remote Control). Record "continued from" lineage and show it with the existing branch tree.
6. Codex (if Codex support exists): summaries for Codex sessions too (summarize with Claude by default; optionally with `codex exec` if I choose it in Settings), and Continue fresh for Codex using its own CLI.
7. Tests: prompt building (size limits, no secrets or tool output dumps), parsing the summary output, lineage, launch command building, and summaries never written to .claude.

Run typecheck, lint, tests and the build. Commit, push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link and a short summary.
```
</details>

---

## 4. Context size before you resume

**What it is:** each session shows how big its context is, and the Resume button warns you before you reload something huge: "Large session: about 180k tokens. Resuming may use about 12% of your 5-hour window. Continue fresh instead?"

**Why it matters:** it connects your usage tracking to everyday choices, so you don't burn a big chunk of your limit just by reopening an old session.

**Details:**
- Context size comes from the last assistant turn's usage in the log (input + cache tokens), and from the status line's `context_window` when available.
- The estimate of the 5-hour cost uses your limit-health baseline. It's labeled as an estimate.
- A size badge on cards (S / M / L / XL) and a sort by size.
- A threshold setting for the warning. Offers "Continue fresh" (feature #3) or "Fork".

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/context-size`.

Read CLAUDE.md and the codebase first. Follow all CLAUDE.md rules and match the existing UI (desktop and phone).

Goal: show each session's context size and warn before resuming a large one.

1. Context size per session: from the last assistant response's usage (input + cache read + cache creation tokens), plus the status line's context_window when available (newer wins). Note whether the session was compacted (find compaction markers in the JSONL) and use the post-compaction size.
2. Estimate the cost of resuming as a % of the 5-hour window, using the existing limit-health baseline ($ per 1% at API-equivalent prices) and the selected model. Label it "estimate" with an ⓘ explanation. If there isn't enough baseline data, show tokens only.
3. UI:
   - A size badge on session cards (S/M/L/XL, with exact tokens on hover) and a sort by context size.
   - In the session stats: tokens, % of the model's context window, and the estimated resume cost.
   - A Resume warning above a threshold (Settings, default 150k tokens) with choices: Resume anyway, Continue fresh (if that feature exists), Fork, Cancel. Never block; one click to go ahead. A "Don't warn for this session" option.
   - Same on the phone.
4. Codex (if Codex support exists): use Codex's token_count/context info the same way.
5. Tests: context calculation (with compaction, missing usage), estimate math, the threshold behavior.

Run typecheck, lint, tests and the build. Commit, push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link and a short summary.
```
</details>

---

## 5. Codex support (Claude, Codex, or both together)

**What it is:** OpenAI Codex sessions in the same app, alongside Claude Code. You can switch between **Claude only**, **Codex only** and **All** everywhere (list, search, usage, limits, phone), and every feature works for Codex wherever Codex makes it possible.

**What carries over to Codex:**

| Feature | Codex | Notes |
|---|---|---|
| Browse, read, search, archive | ✅ | From `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (and `.jsonl.zst`), on Windows + WSL |
| Names, descriptions, tags, pin, hide | ✅ | Plus Codex's own thread names, if it stores them (the agent checks) |
| Resume | ✅ | `codex resume <id>` in the right folder |
| Fork / branch from a message | ⚠️ | Only if Codex supports it; otherwise hidden for Codex |
| Model & effort per session | ✅ | Codex's own flags (`-m`, reasoning effort config), checked with `codex --help` |
| Usage & token tracking | ✅ | From `token_count` events (cumulative, so it computes deltas) |
| Live plan limits (5-hour / weekly) | ✅ | Codex writes `rate_limits` into its logs, **with history**, no bridge needed |
| Limit health ("is it nerfed?") and pacing | ✅ | Separate plan setting and baseline for ChatGPT plans |
| Phone companion | ✅ | View, rename, start `codex resume` on the PC |
| Live phone control | ⚠️ | Through OpenAI's own Codex Remote (ChatGPT app and Codex desktop app), if available on Windows. The dashboard links to it |
| Copy buttons, export, branching tree, stats | ✅ | Same viewer |
| Bypass-approvals toggle | ✅ | Mirrors Claude's skip-permissions setting, never used for phone launches |

**Safety:** never read `~/.codex/auth.json` or call OpenAI/ChatGPT account endpoints. Logs only.

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/codex-support`.

Read CLAUDE.md, docs/ and the codebase first. Follow all CLAUDE.md rules. Don't break any Claude features. ASK ME before reading my real Codex files the first time (read-only), installing anything, or changing system settings.

Goal: add OpenAI Codex as a second provider, with feature parity wherever Codex allows, and a Claude / Codex / All switch everywhere.

1. Provider architecture: refactor discovery, parsing, archive, names, usage, limits, limit health, launching, branching and the phone API behind a provider interface (ClaudeProvider, CodexProvider). All existing Claude tests must keep passing. Each session carries its provider.
2. Switch everywhere: a global "All / Claude / Codex" control (sidebar top and phone), remembered between launches, applied to the list, search, Running now (if present), Usage, Limits, Limit health and exports. In "All", items show a small provider badge/icon (generic icons, no logos), and usage charts can stack or split by provider.
3. Codex sessions: %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl and each WSL distro's ~/.codex/sessions, plus .jsonl.zst via a pure-JS zstd library (no native modules). Also check ~/.codex for thread names/index (e.g. a state DB or session index); read-only. NEVER read, copy or archive ~/.codex/auth.json or any credential file.
   - Parse messages, reasoning, tool calls/outputs into the same viewer with tool steps collapsed.
   - Metadata: id, cwd, model, effort, source (cli/vscode/app), git info.
   - Archive Codex sessions the same way (copy only).
4. Parity, feature by feature (check each against `codex --help` and the Codex docs on this machine; build what's supported, hide or explain what isn't):
   - Names/descriptions/tags/pin/hide; inherit Codex's own thread names if it stores them, same "newest wins" rule as Claude.
   - Resume: `codex resume <id>` in the session cwd (Windows Terminal; WSL via wsl.exe --cd). Copy resume command.
   - Fork/branch: only if Codex supports it; otherwise hide for Codex.
   - Model & effort per session using Codex's own options, with the same session → project → global defaults, kept separate from Claude's.
   - Bypass-approvals toggle mirroring my Claude skip-permissions setting; never used for phone-triggered launches.
   - Usage: token_count events (total_token_usage is cumulative; input includes cached), tracking input, cached input, output and reasoning tokens per model/session/day/week/month/all-time. Codex models in the price table (bundled snapshot), with the "new model detected" behavior.
   - Limits: rate_limits in token_count events (primary ≈ 5h, secondary ≈ weekly; used_percent, window_minutes, resets_at) → gauges, stale handling and history from old sessions. Limit health and pacing with a separate Codex plan setting (ChatGPT Plus/Pro/Business etc. with multipliers) and baseline.
   - Copy buttons, export, stats, branch tree, search, phone screens.
   - Phone: Codex sessions, usage and limits; "Resume on PC" runs `codex resume`. Check whether the Codex desktop app on Windows supports Codex Remote (ChatGPT mobile app) and whether a thread can be opened in it by link or CLI. If yes, add "Open in Codex app"; if not, a short note.
5. Do NOT call any ChatGPT/OpenAI backend or usage endpoint and do NOT use login tokens. Logs only.
6. Tests: Codex fixtures (plain and .zst), cumulative-token handling, rate_limits parsing, the provider switch filtering, launch command building (Windows/WSL, paths with spaces), name inheritance, and that auth.json is never opened.

Work in steps and commit after each. Run typecheck, lint, tests and the build. Push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link, a feature-parity table (✅/⚠️/❌ with reasons), and anything that didn't work on my machine.
```
</details>

---

## 6. What each session changed (git links)

**What it is:** each session is linked to the commits, branches and PRs it produced, and you can see the actual code changes. It answers "which session made this change?" and "what did that session actually do?"

**Details:**
- Matches commits to sessions by repo folder, time window, branch, and Claude's commit trailers (for example the `Claude-Session` line) when present.
- A "Changes" tab in the viewer with the list of commits and files, a diff view, and a link to the PR on GitHub.
- Search by file path: "which sessions touched `bridge.ts`?"
- Reads git only. Never changes your repos.

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/session-git-links`.

Read CLAUDE.md and the codebase first. Follow all CLAUDE.md rules and match the existing UI (desktop and phone).

Goal: link sessions to the git commits, branches and PRs they produced, and show what changed.

1. Read-only git access (spawn the git CLI with argument arrays; never write to repos; WSL repos via wsl.exe git). Handle missing git, non-repos and large repos.
2. Matching: for each session's cwd/repo, find commits during the session's active time on its branch(es), plus commits with a session trailer that names it (e.g. "Claude-Session: …" or similar). Also use files touched by Edit/Write tool calls. Give each match a confidence (exact trailer > branch + time + files > time only), and let me unlink a wrong match.
3. PRs: if `gh` is installed and signed in, look up PRs for those branches/commits (read-only) and link them. Otherwise just show branch names. No other network calls.
4. UI:
   - A "Changes" tab in the viewer with commits (message, time, confidence), files changed, a diff viewer (syntax highlighted, collapsible), and PR links.
   - Badges on session cards ("3 commits · PR #14").
   - Search filters "touched file:" and "commit:".
   - Phone: a read-only commits/files list.
5. Cache results in app data; refresh incrementally.
6. Codex (if Codex support exists): same for Codex sessions (Codex logs include git info).
7. Tests: matching rules, trailer parsing, WSL path handling, and no write commands ever run.

Run typecheck, lint, tests and the build. Commit, push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link and a short summary.
```
</details>

---

## 7. Ask across all sessions

**What it is:** ask questions about your whole history and get answers with links to the exact messages. For example: "Where did I fix the WSL path bug?", "What did I decide about pricing?", or "Which sessions used Opus last week?"

**Why it matters:** your session history becomes a searchable memory of your work, not just a list.

**Details:**
- Two steps: a fast local search finds the most relevant sessions and messages, then Claude answers using only those snippets, through `claude -p` on your subscription.
- Answers always cite their sources (session + message), and each citation opens the viewer at that message.
- Opt-in. A preview shows exactly what will be sent, and you can limit it to selected projects or dates.
- Simple questions about counts ("how many sessions…") are answered locally, without sending anything.

<details><summary><b>Prompt</b></summary>

```
Before starting: `git checkout main`, `git pull`, `npm install`, then `git checkout -b feat/ask-across-sessions`.

Read CLAUDE.md and the codebase first. Follow all CLAUDE.md rules and match the existing UI (desktop and phone).

Goal: ask questions across my whole session history and get answers with citations to exact messages.

1. Retrieval (local): build a chunked index of messages (user/assistant text, tool names and file paths, summaries if the feature exists) using the existing full-text search, improved with BM25-style ranking, plus filters (project, environment, provider, date range, model). Optional local embeddings only if a pure-JS/WASM option works without native modules; otherwise keyword search only.
2. Questions that are really about metadata ("how many sessions…", "which sessions used Opus last week") are answered locally from the metadata and usage data, with nothing sent.
3. Answering: send the question plus the top N snippets (with IDs) to `claude -p` via stdin (no tools, no skip-permissions, timeout and Cancel, using the existing Ask Claude runner rules). Require answers to cite snippet IDs. Show the answer with clickable citations that open the viewer at that message. If the snippets don't contain the answer, say so.
4. Privacy: off until I turn it on. The first time, explain that snippets of my conversations are sent to Claude through my own CLI. Always show "N snippets from M sessions will be sent", with a preview. Scope controls (projects, dates).
5. UI: an "Ask" panel (Ctrl+Shift+K) with history of past questions and answers (stored in app data), on desktop and phone.
6. Codex (if Codex support exists): include Codex sessions, filterable by provider.
7. Tests: chunking, ranking, filters, local-answer routing, citation parsing, and the size limits on what's sent.

Run typecheck, lint, tests and the build. Commit, push the branch and open a PR into main. Do NOT merge, do NOT push to main, and do NOT add or run GitHub Actions. Give me the PR link and a short summary.
```
</details>

---

## Loose ends

- Phone companion still uses the deprecated sync safeStorage encrypt/decrypt calls; switch to the async API in a small PR.

---

## Templates

### Codex review prompt (replace `NN`)

```
Please do a careful READ-ONLY code review of PR #NN: https://github.com/Beaulewis1977/claude-session-dashboard/pull/NN. Don't edit files, commit, push, merge, post on GitHub, or run/trigger/add/edit GitHub Actions. You may fetch, check out the branch, npm install, and run typecheck, lint, tests and the build.

Read CLAUDE.md and the relevant docs first. View the changes with `gh pr diff NN` or `git diff main...<branch>`.

Focus on: correctness and regressions; safety rules in CLAUDE.md (never modifying .claude except approved opt-in changes, no credential reads, network limits, deletions); command building and shell quoting on Windows/WSL; desktop and phone UI, keyboard and accessibility; and test gaps.

Output: a verdict (Approve / Approve with nits / Request changes); findings grouped by severity (Blocker / Should fix / Nit), each with file:line, what's wrong and a suggested fix; and the results of the checks you ran.
```

### Fix-up prompt (after a review)

```
Fix-up for PR #NN based on a code review. Stay on the PR's branch (check it out and pull). No new branch or PR.

Fix these findings: <paste the findings you want fixed>
Don't fix: <paste any you're skipping>. Add them under "Known issues" in the PR description.

Add a test for each fix. Run typecheck, lint, tests and the build. Commit and push to the same branch, and add a short PR comment listing what was fixed. Do NOT merge, do NOT push to main, and do NOT touch GitHub Actions.
```

### Test a PR before merging (on your PC)

```
Quit the installed dashboard (including the tray icon). Check out <branch>, pull, npm install, and start `npm run dev` with my real data so I can test it. When I say I'm done, stop it, check out main, and start the installed app again.
```

### Release prompt (replace `X.Y.Z`)

```
Release version X.Y.Z.

1. `git checkout main`, `git pull`, `npm install`.
2. Create branch release/vX.Y.Z, set the version in package.json and package-lock.json, and add a CHANGELOG entry for everything merged since the last release. Commit, push, open a PR into main, merge it with a merge commit (I approve this one), then pull main.
3. Run tests, then `npm run dist` into a new release\X.Y.Z folder (don't touch older builds).
4. Ask me before closing the running app. Then silent-install X.Y.Z, start it, and confirm the version, live limits and phone access work.
5. Tag vX.Y.Z and create a GitHub Release with `gh release create`, attaching the installer and portable exe, with the changelog as notes.

Don't touch GitHub Actions. Give me a short summary and the release link.
```

**Version numbers:** use `x.y.Z+1` for fixes only (1.4.0 → 1.4.1), and `x.Y+1.0` when there are new features (1.4.1 → 1.5.0).
