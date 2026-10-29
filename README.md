<p align="center"><img src="public/icon-192.png" width="96" alt=""></p>

# AgentsEye

**Your coding agents, in your pocket.** See every Claude Code and Codex session on your Mac, reply to them,
approve their commands, start new ones, and keep an eye on usage limits — from your phone, anywhere.

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
AgentsEye is a PWA: add it to the Home Screen (iPhone: Safari → Share → Add to Home Screen; Android: Install) and it opens full screen, loads instantly from cache, shows "Can't reach your Mac" when offline, and gets notifications. Long-press the icon for shortcuts: New session, This Mac, Lock my Mac.

## Home
- **Usage limits**: Claude Code (live, from its usage endpoint via the Keychain token) and Codex (latest `rate_limits` from its logs) — % used per window and time to reset. Tap to refresh; push alert at 90%.
- **Needs you**: Claude permission requests (Allow / Deny + reason) and sessions waiting for input.
- **Live sessions**: pixel mascots per agent (working / waiting / idle), Claude Code + Codex.
- **Pick up where you left off**, **This Mac** glance (CPU, memory, disk, updates).
- **Composer**: start a new Claude/Codex session in any project, with model, name and skip-permissions options. Runs your own `claude`/`codex` login in Terminal.app; the phone opens the session as soon as it appears.

## Session
- **Names**: your own name (tap the title to rename) › Claude's latest AI title › first prompt; subtitle shows project · git branch. Names also appear in notifications.
- **Helpers**: Claude subagents for the session (type, task, working/done/stopped, last result); tap one to read its transcript.
- **Chat**: transcript with markdown; files the agent mentions get download buttons; reply box.
  Replies are typed into the session's Terminal tab (bracketed paste, foreground re-check), or resume a closed session in a new window. Sessions open in other apps (VS Code, T3…) continue in a copy (`claude --resume --fork-session` / `codex fork`) so two programs never write to one conversation.
- **Terminal**: live screen (2 s), parsed menu choices, Stop / 1 / 2 / 3 / Enter / Mode keys.
- **Files**: newest images, video, audio, PDFs, docs in the project; preview + download.

## This Mac
Processes (quit/force quit), Network (listening ports, exposed vs local), Startup (launch agents: start/stop), Updates (Homebrew/npm one-tap or all, macOS list), Privacy (TCC grants, revoke).

## When you're away
- **Keep awake** (Off / When plugged in / Always): AgentsEye holds a `caffeinate` assertion so agents keep running; the screen still turns off and locks.
- **Lock now** (Home or Settings, also from the phone): turns the display off; with "Require password immediately" the Mac locks while agents keep working.
- **Lid closed**: macOS always sleeps on lid close; this Mac-only switch runs `pmset -a disablesleep 1` (asks for your admin password). Warm in a bag, drains battery — turn off when travelling.

## Preview dev servers
Home → **Preview dev server** lists dev servers on the Mac (node, bun, python…) and opens one on your phone through a signed-in proxy on its own origin (port 4490), including websockets for hot reload. Over Tailscale it uses `https://<mac>.ts.net:8443`, otherwise a second Cloudflare link.

## Phone access & security
- **AgentsEye relay (recommended, nothing to install)**: AgentsEye connects *out* to a relay you deploy free on Cloudflare (`relay/README.md`); your phone opens `https://<relay>/m/<mac-id>`. Works on company Macs behind proxies, no admin rights. Everything is end-to-end encrypted with a key derived from your password — the relay only routes ciphertext.
- **Tailscale (recommended)**: `tailscale serve` gives a private, permanent `https://<mac>.<tailnet>.ts.net`, reachable only from your devices.
- Cloudflare Quick Tunnel (URL changes on restart; AgentsEye follows it).
- Password + **device approval on the Mac**; scanning the QR (single-use, 10 min) skips approval.
- Per-device keys (hashed), sign out any device, rate-limited sign-in, push alert after 20 failures.
- Mac-only actions: approving devices, tunnel, hook install, opening panes on the Mac.
- Web push (VAPID): agent needs OK, agent finished, new device waiting.
- Claude permission prompts go through a `PermissionRequest` hook (Settings → Approvals → Install); unanswered requests fall back to Claude's own prompt.

Data lives in `~/.agentseye` (`AGENTSEYE_HOME`), port `AGENTSEYE_PORT` (4480).
