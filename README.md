# Claude Session Dashboard

A Windows desktop app that finds every Claude Code session on your machine (Windows **and** WSL),
shows them as readable conversations, lets you name, describe and tag them, keeps a permanent
archive, and resumes any session in a terminal with full context.

> Work in progress. See `CLAUDE.md` for the full spec.

## Development

```bash
npm install
npm run dev -- --fixtures   # run with the sample sessions in fixtures/
npm test
```
