# Claude Session Dashboard

A Windows desktop app that collects every Claude Code session from **Windows and WSL**, shows each one
as a readable conversation, lets you name, describe and tag it, keeps a permanent archive, and
resumes any session in a terminal with its full context.

![Main screen](docs/main.png)

- **Every session in one place.** Your Windows profile and every WSL distro (each user in `/home`,
  plus `/root`), plus any extra folders you add. New and updated sessions show up live.
- **Readable transcripts.** Chat bubbles, Markdown, syntax-highlighted code, and collapsed tool calls
  (`▸ Edit src/app.ts`, `▸ Bash: npm test`) and thinking blocks that you expand on click.
  Find-in-session with <kbd>Ctrl</kbd>+<kbd>F</kbd>.
- **Your own names, descriptions and tags.** Stored only in the app's own metadata file and never
  written into Claude's files. Untitled sessions fall back to Claude's summary, then to the first
  message.
- **Resume and Fork** in Windows Terminal (or PowerShell / cmd). `--dangerously-skip-permissions`
  is on by default, with a per-launch checkbox and a warning label. "Copy resume command" lets you
  paste it yourself.
- **A permanent archive.** Every session file is copied to `%APPDATA%\ClaudeSessionDashboard\archive`,
  so sessions survive Claude Code's `cleanupPeriodDays` cleanup. If the original is gone, Resume puts
  the archived copy back first (it never overwrites an existing file).
- **Full-text search** across names, descriptions, tags and all message text, plus filters for
  project, environment, tag, date range and hidden sessions.
- **Keyboard first.** <kbd>Ctrl</kbd>+<kbd>K</kbd> command palette, <kbd>J</kbd>/<kbd>K</kbd> to move,
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to resume, <kbd>?</kbd> for every shortcut. Light, dark and
  system themes.

## Safety

The app is built around these rules (see `CLAUDE.md`):

1. **It never deletes or modifies anything under any `.claude` folder.** It only reads. The one
   exception: when you resume a session whose file is _missing_, it copies the archived copy back to
   the original path. That copy uses an exclusive-create flag, so it can never overwrite a file.
   Every other write goes through a guard that refuses any path inside a `.claude` folder or outside
   the app's data folder.
2. The app's own data lives only in `%APPDATA%\ClaudeSessionDashboard\` (metadata, settings, archive,
   cache, and Chromium's own files).
3. There is no "delete session" feature. **Hide** is only a flag in the app's metadata.
4. **No network calls.** All outgoing requests from the window are blocked, remote images in
   transcripts aren't loaded, and fonts are bundled. Links in transcripts open in your browser only
   when you click them.

## Run it on Windows

You need **Node.js 22.12 or newer** (the LTS from <https://nodejs.org> is fine) and **Git**.
No Visual Studio or other build tools are needed: the project uses no native Node modules.

Open **PowerShell** and run:

```powershell
git clone https://github.com/Beaulewis1977/claude-session-dashboard.git
cd claude-session-dashboard
npm install
npm run dev
```

The app opens and scans your sessions. To try it with the sample sessions in `fixtures/` instead
of your real data:

```powershell
npm run dev -- --fixtures
```

### Build the installer

```powershell
npm run dist
```

This creates two files in `release\1.0.0\`:

- `ClaudeSessionDashboard-Setup-1.0.0.exe` is the installer (per-user, no admin rights needed; you can
  pick the install folder).
- `ClaudeSessionDashboard-Portable-1.0.0.exe` runs without installing.

The executables aren't code-signed, so Windows SmartScreen may warn you the first time. Click
**More info**, then **Run anyway**.

### Other scripts

| Command                          | What it does                                                  |
| -------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                    | Run with hot reload. Add `-- --fixtures` for sample data.     |
| `npm start`                      | Run the last production build (`npm run build` first).        |
| `npm test`                       | Unit and integration tests (Vitest).                          |
| `npm run typecheck`              | TypeScript checks for the main process and the renderer.      |
| `npm run lint`                   | ESLint.                                                       |
| `npm run check`                  | Typecheck, lint, test and build in one go.                    |
| `npm run dist`                   | Build the Windows NSIS installer and the portable exe.        |
| `npm run dist:dir`               | Build an unpacked app folder (quick packaging check).         |
| `npm run screenshots`            | Run the app in fixtures mode and save screenshots to `docs/`. |
| `node scripts/make-fixtures.mjs` | Regenerate the sample sessions in `fixtures/`.                |

## Using it

- **Rename / describe / tag:** click the title or description at the top of a session, or press
  <kbd>F2</kbd>, <kbd>D</kbd> or <kbd>T</kbd>. Changes save when you leave the field.
- **Resume / Fork:** <kbd>Ctrl</kbd>+<kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>,
  or the buttons in the header. The dialog shows the exact command, whether the file will be
  restored from the archive, and whether the working folder still exists. If it doesn't, choose
  another folder. Fork adds `--fork-session` so the original session stays untouched.
- **Search:** press <kbd>/</kbd> and type. Results are sorted by relevance; a small "in messages" label
  means the match is in the conversation rather than the name or tags.
- **Settings** (<kbd>Ctrl</kbd>+<kbd>,</kbd>): theme, terminal, the default for skipping permissions,
  scan sources with their status, extra folders, the archive location and size, and each Claude
  home's `cleanupPeriodDays` (read-only).

The launch commands are built as argument arrays and started with `child_process.spawn` (detached),
so paths with spaces work:

```text
Windows session:  wt.exe -d "<cwd>" cmd /k claude --resume <id> [--dangerously-skip-permissions] [--fork-session]
WSL session:      wt.exe wsl.exe -d <distro> --cd "<linux-cwd>" -- bash -lic "claude --resume <id> [...]"
```

If `wt.exe` isn't found, the app falls back to a new PowerShell window. You can also pick PowerShell
or cmd as your preferred terminal.

### Keeping sessions longer in Claude Code itself

Claude Code deletes sessions older than `cleanupPeriodDays` (30 by default). The archive keeps them
anyway, but if you also want Claude Code to keep them, add this to `%USERPROFILE%\.claude\settings.json`
(and `~/.claude/settings.json` inside WSL). The app shows the current value but never edits this file.

```json
{ "cleanupPeriodDays": 3650 }
```

## Screenshots

|                                   |                                              |
| --------------------------------- | -------------------------------------------- |
| ![Tool calls](docs/tools.png)     | ![Resume dialog](docs/resume-dialog.png)     |
| ![Find in session](docs/find.png) | ![Command palette](docs/command-palette.png) |
| ![Settings](docs/settings.png)    | ![Light theme](docs/main-light.png)          |

## How it works

```
src/
  shared/      Types and pure logic used by both processes: JSONL parsing, titles, Markdown export
  main/
    core/      Small, tested building blocks: WSL decoding, launch commands, archive, restore,
               atomic JSON store, write guards
    services/  Source detection, the session catalogue, search index, watcher, launcher
    platform.ts  Everything that touches the OS (wsl.exe, wt.exe, spawn), with a fixtures version
    ipc.ts     The API the window can call
  preload/     Exposes that API as window.csd (context isolation, sandboxed)
  renderer/    React UI (Tailwind CSS, shadcn-style components on Radix, lucide icons)
fixtures/      Sample Windows and WSL sessions, including malformed lines and old formats
tests/         Vitest unit and integration tests
```

- **Parsing** is defensive: every line is parsed on its own, and lines that aren't JSON objects are
  skipped and counted (the viewer shows how many). Consecutive assistant lines that share a message
  id are merged, and tool results are attached to their tool calls.
- **The working directory** for resume comes from the `cwd` field in the session's events, never from
  the encoded folder name.
- **WSL:** distros are listed with `wsl.exe -l -q`, whose output is UTF-16LE (decoded, with null bytes
  and blank lines removed). Each distro is read through `\\wsl.localhost\<distro>`, falling back to
  `\\wsl$\<distro>`. Docker Desktop's internal distros are skipped.
- **Live updates:** local folders are watched with chokidar. `\\wsl$` shares don't deliver reliable file
  events, so WSL folders are polled every 10 seconds.
- **Archive:** a session is copied when it's new or has grown. A file that shrank or was rewritten is
  not copied over the archive, so the archive never loses data. Size, SHA-256, original path,
  environment and `cwd` are recorded in `metadata.json`.
- **Storage:** `metadata.json` and `settings.json` are written atomically (temp file, then rename).
  Search uses MiniSearch (pure JS). A startup cache of summaries and the search index means only
  changed files are re-parsed at launch.

## Decisions and notes

These are choices I made where the spec left room, or had to deviate:

- **No GitHub Actions workflow.** The spec asks for one, but you asked me not to create one (your
  Actions minutes are used up). `npm run check` and `npm run dist` run the same steps locally.
- **TypeScript 6.0.3, not 7.0.2.** 7.0.2 is the newest stable release, but it's the new native
  compiler and the newest `typescript-eslint` (8.72.0) only supports TypeScript below 6.1. Every
  other dependency is the latest stable version, pinned exactly.
- **Phases.** Your message mentioned four phases under "Deliverables" and a "UI / UX design" section,
  but the `CLAUDE.md` I received has neither. I split the work into: (1) scaffold, core parsing and
  safety modules with tests, (2) the main-process services, (3) the UI, and (4) packaging, icon,
  startup cache and docs.
- **Stopped WSL distros** aren't scanned by default, because reading `\\wsl$\<distro>` starts the
  distro. They show as "Not running" with a notice. A setting turns scanning them on.
- **Sessions whose source is offline** (for example, a stopped distro) show their archived copy
  with an "Offline" label rather than disappearing.
- **Choosing a different folder for Resume:** Claude Code looks sessions up by project folder, so
  resuming from a different folder may not find the session. The dialog says so. The app does not
  copy the session into another project folder, because that would mean writing into `.claude`.
- **Copy resume command** copies the full launch command (it works from Run, cmd or PowerShell).
  "Copy claude command only" copies just `claude --resume …` for pasting into a terminal that's
  already in the right folder.
- **Renderer libraries are dev dependencies.** Vite bundles them, so only `chokidar` and
  `minisearch` (used by the main process) ship in the installer.
- **Fixtures mode** copies `fixtures/` into `.fixtures-data/` (git-ignored) and runs against that copy.
  Launching only shows the command. To reset the sample data, delete `.fixtures-data/` yourself; the
  app never deletes anything.
- **Code fonts:** JetBrains Mono ligatures are turned off so code shows the characters that are really
  there (`=>` stays `=>`).

## Troubleshooting

- **A WSL distro shows "Can't read".** Open the distro once (for example `wsl -d Ubuntu`), then press
  <kbd>F5</kbd> in the app to rescan.
- **Resume opens a window that closes immediately (WSL).** Check that `claude` works in a login shell:
  `wsl -d <distro> -- bash -lic "claude --version"`.
- **Nothing shows up.** Open Settings and check the scan sources. Add your `.claude` folder with
  **Add folder…** if it lives somewhere unusual.
