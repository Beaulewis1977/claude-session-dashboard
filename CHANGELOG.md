# Changelog

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
