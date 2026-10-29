<p align="center"><img src="public/icon-192.png" width="96" alt=""></p>

# AgentsEye

**Your coding agents, in your pocket.** See every agent on your Mac — Claude Code and Codex (Terminal, VS Code,
T3 Code), Cursor and GitHub Copilot — chat with them, answer their questions, review and commit their changes,
and get a ping when one finishes or needs you. From your phone, anywhere.

- Works on **company Macs**: no admin rights, no Homebrew, no tunnels. Only an outbound HTTPS connection.
- **End-to-end encrypted**: phone and Mac share a key derived from your password; the relay sees ciphertext only.
- Uses **your own** Claude Code / Codex logins. Free and open source (MIT).

## Install (Mac)

Website: **https://agentseye.agentseye.workers.dev**

```bash
curl -fsSL https://agentseye.agentseye.workers.dev/install.sh | sh
```

It installs into `~/.agentseye` (downloading a private Node if needed), starts at login, keeps itself updated, and
opens `http://localhost:4480`. Choose a password, scan the QR code with your phone, add it to your Home Screen.
Remove with `… | sh -s -- --uninstall`.

## Publish your own (free)

1. **GitHub:** push this repo (public). Put `owner/name` in `relay/wrangler.toml` (`REPO`) and `package.json`.
2. **Relay + website:** `cd relay && npm install && npx wrangler login && npx wrangler deploy`
   → `https://agentseye.<account>.workers.dev` serves the landing page, `/install.sh`, `/privacy`, and the relay.
3. Share that link. Optional: `npm publish` so people can also run `npx agentseye`.

Cloudflare's free plan (100k requests/day) covers roughly 10–20 daily users; the app refreshes less often over the
relay and when idle. Anyone can deploy their own relay with the same two commands.

## Develop

```bash
npm install && npm start      # http://localhost:4480
npm test
```

## App on your phone
AgentsEye is a PWA: add it to the Home Screen (iPhone: Safari → Share → Add to Home Screen; Android: Install) and it opens full screen, loads instantly from cache, shows "Can't reach your Mac" when offline, and gets notifications.

## Agents
One list, grouped into **Needs you**, **Working** and **Recent**, with search and a filter per app. Usage limits for Claude Code and Codex sit at the bottom; **＋** starts a new chat (in T3 Code when it's running, otherwise in Terminal).

| Agent | See it | Chat from the phone | Answer its questions | Notified when |
|---|---|---|---|---|
| T3 Code (Claude / Codex) | ✓ | ✓ (shows in the desktop app too) | ✓ | done, needs input, failed |
| Claude Code in Terminal | ✓ | ✓ typed into its tab | ✓ (hook) | done, needs input |
| Claude Code in VS Code | ✓ | ✓ by moving the same chat to Terminal | ✓ (hook) | done, needs input |
| Codex CLI | ✓ | ✓ typed into its tab; menus from the Terminal tab | via Terminal tab | — |
| Cursor | ✓ read only | — (Open on Mac) | — | done, waiting for approval |
| GitHub Copilot (VS Code) | ✓ read only | — (Open on Mac) | — | done |

## Chat
- **Composer**: quick replies (Continue, Yes, Run the tests, Commit it) and **photos** (shrunk on the phone, saved in `~/.agentseye/uploads`, passed to the agent by path).
- **While an agent works** the box stays open: messages are **queued** and sent the moment it finishes, even with the phone closed. Cancel a queued one with a tap.
- **Questions** Claude asks show as tappable options; **permission prompts** have Deny / **Always** / Allow. *Always* adds the exact command (or tool) to the project's `.claude/settings.local.json`.
- **Changes (±)**: the project's changed files with diffs; commit, or commit and push, from the phone.
- Claude sessions also have **Helpers** (subagents), **Terminal** (live screen and keys) and **Files**.

## Notifications
Titled with the chat's name: ✅ finished (with the start of the reply), ✋ needs you (with the question), ⚠️ failed. Plus usage limits at 90%, new devices, and an optional **daily summary** in the evening.

Prompts go to the phone **when you're away from the Mac** (no keyboard or mouse for 2 minutes) or always — Settings → Approvals.

## When you're away
- **Keep awake** (Off / When plugged in / Always): AgentsEye holds a `caffeinate` assertion so agents keep running; the screen still turns off and locks.
- **Lock now**: turns the display off; with "Require password immediately" the Mac locks while agents keep working.
- **Lid closed**: macOS always sleeps on lid close; this Mac-only switch runs `pmset -a disablesleep 1` (asks for your admin password). Warm in a bag, drains battery — turn off when travelling.

## Phone access & security
- **AgentsEye relay (recommended, nothing to install)**: AgentsEye connects *out* to a relay you deploy free on Cloudflare (`relay/README.md`); your phone opens `https://<relay>/m/<mac-id>`. Works on company Macs behind proxies, no admin rights. Everything is end-to-end encrypted with a key derived from your password — the relay only routes ciphertext.
- **Tailscale (recommended)**: `tailscale serve` gives a private, permanent `https://<mac>.<tailnet>.ts.net`, reachable only from your devices.
- Cloudflare Quick Tunnel (URL changes on restart; AgentsEye follows it).
- Password + **device approval on the Mac**; scanning the QR (single-use, 10 min) skips approval.
- Per-device keys (hashed), sign out any device, rate-limited sign-in, push alert after 20 failures.
- Mac-only actions: approving devices, tunnel, hook install, opening panes on the Mac.
- Web push (VAPID): agent needs you, agent finished, new device waiting, daily summary.
- Claude's permission prompts and questions go through a `PermissionRequest` hook (Settings → Approvals → Install); unanswered requests fall back to Claude's own prompt.
- Changes and commits only ever touch the project folder of an agent AgentsEye knows; the phone never names a path.

Data lives in `~/.agentseye` (`AGENTSEYE_HOME`), port `AGENTSEYE_PORT` (4480).
