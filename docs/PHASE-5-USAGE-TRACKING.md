# Phase 5 — Usage, Limits & Model Tracking

An add-on phase for **claude-session-dashboard**. Build it into the existing app.

**Before starting:** read `CLAUDE.md` and the existing code. All of `CLAUDE.md`'s rules still apply:
- No native Node modules.
- No GitHub Actions workflows.
- Use latest stable dependency versions (check them with `npm view`).
- Match the existing UI quality, components and themes.

This phase adds **two narrow, opt-in exceptions** to CLAUDE.md's safety rules. They're described in sections A and C below. Nothing else changes.

Save this file in the repo as `docs/PHASE-5-USAGE-TRACKING.md`. Add a line to `CLAUDE.md` pointing to it, and note the two exceptions there.

**My setup:** Claude **Max 5x** subscription (signed in to Claude Code with my Claude account) on Windows and WSL. I may also add an API key later.

---

## Goal

A **Usage** view (sidebar entry + `Ctrl+U`) that shows:
1. **My real subscription limits, live.** These are the same 5-hour and weekly percentages Claude Code shows in `/usage`, with reset countdowns.
2. **Every token I use, forever.** Broken down per model, per session, per project, and per day, week, month and all-time.
3. **API usage, cost and credits**, when I add an API key. I can also launch any session on API credits instead of my subscription.
4. **Model performance trends** ("is it nerfed?") and **limit-change detection** ("did my limits get smaller?").

The app does the same job as ccusage (local JSONL analysis, 5-hour blocks, per-model breakdowns), plus real plan percentages, history forever, and a GUI.

---

## A. Live subscription limits (status line bridge) — opt-in

**How it works.** Claude Code passes a JSON payload to any configured `statusLine` command on every update. For Pro/Max users it includes:

```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

It also includes `model`, `session_id`, `cwd`, `version`, `cost` and `context_window` (including `used_percentage`).

This is the **only supported way** to get real plan-limit data locally. The field only appears for Claude subscriptions, and only after the first response in a session. Its shape can change or go missing in some Claude Code versions, so handle it defensively.

**Bridge script.** The app ships a tiny, dependency-free status line script for each environment:
- A PowerShell script for Windows.
- A POSIX `sh` script for WSL. No `jq` or `node` required: it saves the raw stdin JSON.

Each run, the script:
1. Writes the raw JSON atomically (temp file + rename) to `<env home>/.claude-session-dashboard/live/<session_id>.json` and `latest.json`.
2. **If I already had a status line command, it pipes the same JSON to that command and prints its output**, so my existing status line still shows. Otherwise it prints a short line: model · 5h % · week % · context %.
3. Finishes fast (< 50 ms target) and never fails loudly. On any error it prints nothing and exits 0.

**Installing (exception #1 to the "never modify .claude" rule).** Installing requires adding a `statusLine` entry to `~/.claude/settings.json` in each environment I choose (Windows and/or each WSL distro).
- It is **only** done when I click "Enable live limits" for that environment.
- First show a confirmation dialog with the **exact diff** to `settings.json`, and which existing status line command (if any) will be chained.
- Back up `settings.json` to the app data folder first, with a timestamp.
- Change only the `statusLine` key. Keep all other content and formatting intact. Never delete anything.
- Provide "Disable live limits", which restores my previous `statusLine` value exactly (with the same confirmation dialog).
- Show the bridge status in Settings: enabled/disabled per environment, last data received.

**The app reads** the `live/` folders (Windows directly; WSL via `\\wsl.localhost\...`), watches them for changes, and keeps a **history** of every reading in its own data folder (`limits-history.ndjson`), so trends are kept forever.

**Do NOT** read Claude's OAuth credentials (e.g. `.credentials.json`), and don't call any undocumented or OAuth-only usage endpoint. Subscription OAuth tokens are only for Claude Code and Claude.ai. The status line bridge is the supported route.

---

## B. Token tracking from session logs (no setup needed)

**Data source.** Assistant events in the JSONL include `message.model` and `message.usage`, with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and sometimes nested cache/server-tool fields.
- Parse every usage field present. Store unknown numeric fields too, so new token types show up automatically.
- **Count each API response only once.** One response can appear on several JSONL lines. Dedupe by `message.id` + `requestId` (the same approach as ccusage).
- Record per response: timestamp, session, project, environment, model, Claude Code `version`, and stop reason.
- Use the archive as the source, so history survives Claude Code's cleanup.
- Store aggregates in the app data folder in an append-friendly format (monthly NDJSON/JSON). Update incrementally. Add a "Recalculate usage" button.
- Optional "Verify against ccusage" button: if `ccusage` is installed, run `ccusage daily --json` and show any differences.

**Breakdowns (all switchable):**
- By **model**, **session**, **project**, **environment**, **Claude Code version**.
- By **day / week / month / all-time**, with a date range picker. Use the local time zone, with weeks starting Monday (setting).
- Each token type separately and stacked: input, output, cache write, cache read, plus a total.
- Charts: stacked area/bar over time, model share donut, top sessions table. Use a well-maintained charting library (e.g. Recharts), styled to match the light and dark themes.
- Per-session usage in the session detail panel.
- CSV export.

---

## C. API key support — opt-in (exception #2 to "no network calls")

Settings → **Accounts**: add one or more API keys, each with a nickname.
- Store keys with Electron `safeStorage` (Windows DPAPI). Never store them in plain text, never log them, and show them masked.
- **Admin API key** (`sk-ant-admin…`, organization accounts only): pull history from the **Usage & Cost Admin API** (`/v1/organizations/usage_report/messages` and `/v1/organizations/cost_report`). Show daily/weekly/monthly tokens and USD cost per model and per key alongside local data. Refresh on demand and every N minutes (setting). Explain clearly that individual accounts can't create Admin keys.
- **Standard API key** (`sk-ant-api…`): usage history isn't available from the API with a standard key. Use it to label sessions that ran on API billing (if detectable from logs) and show those sessions' token usage and estimated cost from local logs.
- Network access is allowed **only** to `https://api.anthropic.com`, **only** when I've added a key, and **only** for these read-only reporting calls. Never send session content anywhere.

### Running sessions on API credits (switch billing per launch)

Sometimes I get API credits from Anthropic and want to spend those instead of my Max 5x limits.

- Add a **Billing** choice to the Resume/Fork launch options and to "New session": **Subscription (Max 5x)** (default) or **API key: <nickname>**.
- Add a Settings default for this, and an optional per-project default ("always use API credits for this project").
- **Launching with an API key:**
  - Give the new Claude Code process `ANTHROPIC_API_KEY` **only for that one terminal**.
  - Never write it to `settings.json`, shell profiles, global environment variables, command-line arguments (visible in the process list) or logs.
  - Windows: start the terminal process with the key in its own environment. Verify this works with Windows Terminal, because a new `wt` window can join an already-running Windows Terminal and inherit *its* environment instead. If the key can't be passed safely through `wt`, fall back to launching PowerShell directly for API-billed sessions, and explain why in the UI.
  - WSL: pass it through the environment with `WSLENV=ANTHROPIC_API_KEY/u`, not in the command string.
  - Claude Code may ask once to confirm using the API key. Mention this in a tooltip.
- Tag each session with the billing mode it was launched with, and show a badge on the session card: **Max** or **API · <nickname>**.
  - For sessions launched outside the app, infer billing from the bridge: `rate_limits` present means subscription. A `cost` payload without `rate_limits` likely means API. Otherwise mark it "Unknown".

### Credits tracker

There's no API to read a remaining credit balance, so I enter it myself.

- For each API key: add credit grants (amount in USD, date received, optional expiry date).
- Spending is calculated from the bridge's `cost.total_cost_usd` for API-billed sessions. If that's missing, fall back to the price table × tokens from the logs.
- Show a credits card: remaining balance, spent this week/month, burn rate, "lasts about N days at this pace", and expiry warnings.
- If an Admin key exists for that organization, show the Admin API cost report next to it as the authoritative figure.

**Cost estimates:** a price table per model per token type in Settings. Pre-fill it from Anthropic's current published API prices, with a note giving the date the prices were filled in. Keep it fully editable by me.

---

## D. Limits view

- **Plan** setting: Pro, Max 5x, Max 20x, API, or Team/Enterprise. **Default: Max 5x.**
- Top of the Usage view: two large gauges, **Current 5-hour window** and **This week**. Each shows used % (from the bridge), reset time and countdown, tokens used so far in that window (from logs), and a burn-rate projection ("at this pace you'll hit 100% in ~1h 20m").
- Mark the data as stale if the last bridge reading is old ("Last updated 3h ago — open Claude Code to refresh").
- Alerts: desktop notifications at 75% and 90% (configurable, can be turned off).
- **Implied capacity (limit-change detector):** for each reading, estimate the window's full capacity as `tokens used in window ÷ (used_percentage / 100)`. Do this per model mix, using a weighted token total (setting for weights, default: output and cache-write weighted higher than input/cache-read). Chart the implied capacity over time. If it drops noticeably, flag it ("Your effective 5-hour capacity looks ~25% lower than last month").
  - Show a clear caveat: Anthropic's limits aren't purely token counts, so this is an estimate.
- Log every "usage limit reached" / rate-limit message found in sessions, with the time and tokens used in that window.
- Without the bridge enabled, fall back to log-only 5-hour blocks (like `ccusage blocks`), with a banner offering to "Enable live limits".

---

## E. Model performance trends ("is it nerfed?")

This can't *prove* anything, because results depend on what I was working on. Present these as **trend indicators**, with that caveat shown on the screen. Track per model **and** per Claude Code version, over time:
- Average output tokens per response, and per user turn.
- Response latency (time between a user message and the assistant reply, from timestamps).
- Tool error rate, and the share of turns that hit an API error or retry.
- Assistant turns and tool calls per user message.
- How often I interrupt or correct (messages right after an interruption, or ones starting with "no", "wrong" or "that's not").
- Cache read ratio.
- Thinking blocks per response, and their length.
- Context window usage per session (from the bridge).

Show each metric as a weekly line chart. Add markers where the model ID or Claude Code version changed, and where implied capacity changed. Add a **compare mode**: pick two date ranges or two versions and show the metrics side by side with the % change.

---

## F. Usage & limits UI design (high priority)

This should be the nicest screen in the app: modern, calm and readable at a glance, like Vercel's or Linear's dashboards, or Apple's Screen Time. Not a spreadsheet.

**Layout of the Usage view (top to bottom)**
1. **Hero row:** two large ring gauges, **5-hour window** and **This week**.
   - The percentage is in big type in the center, with "Resets in 2h 14m" under it.
   - A thin burn-rate line underneath ("On pace to hit 100% at 4:30 PM").
   - If API keys exist, a third card for **API credits**: remaining $, a small spend sparkline, and "lasts ~12 days."
2. **Summary cards:** Today · This week · This month · All-time.
   - Each shows total tokens (formatted like `1.2M`), the change vs. the previous period (▲ 18%), and a small sparkline.
   - Click a card to filter the charts below.
3. **Main chart:** stacked area chart of token types over time.
   - Day/Week/Month toggle (segmented control) and a model filter (chips).
   - Hovering shows a crosshair with a clean tooltip listing every token type, the total and the cost.
4. **Two-column section:** model share donut (with legend and %) | top sessions list (name, project, tokens, a small bar). Clicking a session opens it.
5. **Tabs:** Trends ("is it nerfed?"), Limit history (implied capacity), Credits, Raw table.

**Visual rules**
- One consistent color per token type and per model, used everywhere (charts, chips, legends). Pick colors that work in both themes and for color-blind users.
- Gauge colors by level: calm/neutral under 50%, amber 75–90%, red over 90%. Don't use red anywhere else.
- Large readable numbers, with full values on hover (`1,234,567 tokens`). Abbreviate in cards (`1.2M`, `$4.81`). Use local date/time formats.
- Generous spacing, rounded cards, subtle borders and shadows, no clutter. Hide gridlines or keep them very light.
- Smooth, short animations: gauges fill on load and numbers count up (under 400 ms). Respect "reduce motion".
- Every chart has a short plain-English subtitle ("How many tokens you used each day, by type").
- Caveats appear as a small ⓘ with a tooltip, not as walls of text.
- Clear empty and loading states: skeleton placeholders while loading, and friendly prompts ("Enable live limits to see your real Max 5x usage").
- Fully responsive inside the window, from narrow to wide (cards wrap; the two-column section stacks).

**At-a-glance extras**
- A **system tray icon** that shows the current 5-hour % (a small ring or number badge). Its tooltip shows both windows and reset times; clicking it opens the Usage view.
- An optional **mini meter**: a small always-on-top floating window with the two gauges and the credits balance. It can be dragged and remembers its position.
- The usage gauges also appear small in the app's status bar.

---

## Tests

- Dedupe (the same message id across several lines).
- Aggregation across day/week/month boundaries and time zones.
- 5-hour block grouping.
- Missing or unknown usage fields.
- Parsing bridge payloads, including missing `rate_limits` and both epoch and ISO `resets_at` formats.
- The settings.json installer: preserves other keys, chains an existing status line, backs up first, and the uninstall restores the original exactly.
- Bridge scripts: run them with sample JSON (sh in the cloud environment; the PowerShell one with a Pester test if possible, otherwise a documented manual test).
- Implied-capacity calculation.
- Key storage never writes plain text.
- API-billed launches: the key is only in the child process environment, never in arguments or files, for both the Windows and WSL command builders.
- Credits math: grants, expiry, spend from the bridge cost vs. the price-table fallback.
- Add realistic usage, bridge and Admin API fixtures so every screen looks full in fixtures mode.

---

## Done when

- Typecheck, lint, tests and build all pass.
- Screenshots of the Usage view and Limits gauges (light and dark) are in `docs/`.
- The README explains:
  - how to enable live limits and what it changes in `settings.json`
  - how to add API keys
  - what each number means and its limits
- Everything is committed and pushed.
